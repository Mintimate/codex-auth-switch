//! 根据官方 App Server 认证文档独立实现：
//! https://learn.chatgpt.com/docs/app-server#auth-endpoints
//! 认证材料只在后端和本次临时 Home 中流转，不透传 RPC 错误或子进程输出。
use crate::{
    codex_app_server,
    diagnostic_log::{Operation, Outcome, Trace},
    manager::{validate_chatgpt_auth, AccountManager},
    proxy,
    query_gate::QueryGate,
};
use futures_util::future::{select, Either};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{watch, Mutex},
    time::timeout,
};

const RPC_TIMEOUT: Duration = Duration::from_secs(25);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MESSAGE: usize = 1024 * 1024;
const MAX_PENDING: usize = 32;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LoginError {
    Unavailable,
    Unsupported,
    PortInUse,
    Network,
    RateLimited,
    Rejected,
    InvalidResponse,
    Storage,
    Expired,
    Cleanup,
    Cancelled,
    Busy,
    Browser,
    Clipboard,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Preparing,
    Waiting,
    Saving,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    pub session_id: String,
    pub phase: Phase,
    pub error: Option<LoginError>,
    pub profile_id: Option<String>,
    pub cleanup_pending: bool,
}

struct Session {
    status: LoginStatus,
    auth_url: Option<String>,
    cancel: watch::Sender<bool>,
    done: watch::Receiver<bool>,
}

#[derive(Default, Clone)]
pub struct HostedLoginState {
    inner: Arc<Mutex<Option<Session>>>,
}

impl HostedLoginState {
    pub async fn active(&self) -> bool {
        self.inner
            .lock()
            .await
            .as_ref()
            .is_some_and(|s| !*s.done.borrow() || s.status.cleanup_pending)
    }

    pub async fn status(&self) -> Option<LoginStatus> {
        self.inner.lock().await.as_ref().map(|s| s.status.clone())
    }

    pub async fn start(
        &self,
        manager: AccountManager,
        label: String,
        operation: Arc<Mutex<()>>,
        queries: Arc<QueryGate>,
    ) -> Result<LoginStatus, LoginError> {
        self.start_with(manager, label, operation, queries, spawn)
            .await
    }

    async fn start_with(
        &self,
        manager: AccountManager,
        label: String,
        operation: Arc<Mutex<()>>,
        queries: Arc<QueryGate>,
        spawn_process: impl FnOnce(&Path) -> Result<Child, LoginError> + Send + 'static,
    ) -> Result<LoginStatus, LoginError> {
        {
            let _operation = operation.lock().await;
            manager
                .validate_login_label(&label)
                .map_err(|_| LoginError::Storage)?;
        }
        let mut current = self.inner.lock().await;
        if current
            .as_ref()
            .is_some_and(|s| !*s.done.borrow() || s.status.cleanup_pending)
        {
            return Err(LoginError::Busy);
        }
        let home = create_home(&manager)?;
        let id = home
            .path()
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or(LoginError::Storage)?
            .to_owned();
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (done_tx, done_rx) = watch::channel(false);
        let status = LoginStatus {
            session_id: id.clone(),
            phase: Phase::Preparing,
            error: None,
            profile_id: None,
            cleanup_pending: true,
        };
        *current = Some(Session {
            status: status.clone(),
            auth_url: None,
            cancel: cancel_tx,
            done: done_rx,
        });
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut commit_cancel = cancel_rx.clone();
            let result = run_login(&state, &id, &home, cancel_rx, spawn_process).await;
            // 先停止官方进程，再读最终凭据，随后在锁内提交；浏览器等待不占用全局锁。
            let result = match result {
                Ok(auth) => {
                    state
                        .commit(
                            &id,
                            &manager,
                            &label,
                            &auth,
                            &operation,
                            &queries,
                            &mut commit_cancel,
                        )
                        .await
                }
                Err(error) => Err(error),
            };
            let cleaned = home.close().is_ok() && result != Err(LoginError::Cleanup);
            let mut current = state.inner.lock().await;
            if let Some(session) = current.as_mut().filter(|s| s.status.session_id == id) {
                session.auth_url = None;
                session.status.cleanup_pending = !cleaned;
                if let Err(error) = result {
                    session.status.phase = if error == LoginError::Cancelled {
                        Phase::Cancelled
                    } else {
                        Phase::Failed
                    };
                    session.status.error = Some(error);
                }
                if !cleaned {
                    session.status.error = Some(LoginError::Cleanup);
                }
            }
            let _ = done_tx.send(true);
        });
        Ok(status)
    }

    async fn commit(
        &self,
        id: &str,
        manager: &AccountManager,
        label: &str,
        auth: &Value,
        operation: &Mutex<()>,
        queries: &QueryGate,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<(), LoginError> {
        if *cancel.borrow() {
            return Err(LoginError::Cancelled);
        }
        {
            let mut current = self.inner.lock().await;
            let session = current
                .as_mut()
                .filter(|s| s.status.session_id == id && !*s.cancel.borrow())
                .ok_or(LoginError::Cancelled)?;
            session.auth_url = None;
            session.status.phase = Phase::Saving;
        }
        let commit = async {
            let _queries = queries.exclusive().await;
            let _operation = operation.lock().await;
            let mut current = self.inner.lock().await;
            let session = current
                .as_mut()
                .filter(|s| s.status.session_id == id && !*s.cancel.borrow())
                .ok_or(LoginError::Cancelled)?;
            session.status.phase = Phase::Saving;
            let profile_id = manager
                .save_hosted_login(auth, label)
                .map_err(|_| LoginError::Storage)?;
            session.status.profile_id = Some(profile_id);
            session.status.phase = Phase::Completed;
            Ok(())
        };
        match select(Box::pin(cancel.changed()), Box::pin(commit)).await {
            Either::Left(_) => Err(LoginError::Cancelled),
            Either::Right((result, _)) => result,
        }
    }

    pub async fn cancel(&self, id: &str) -> Result<LoginStatus, LoginError> {
        let mut done = {
            let mut current = self.inner.lock().await;
            let session = current
                .as_mut()
                .filter(|s| s.status.session_id == id)
                .ok_or(LoginError::Cancelled)?;
            if session.status.phase != Phase::Completed {
                let _ = session.cancel.send(true);
                session.auth_url = None;
            }
            session.done.clone()
        };
        if !*done.borrow() {
            timeout(Duration::from_secs(12), done.changed())
                .await
                .map_err(|_| LoginError::Cleanup)?
                .map_err(|_| LoginError::Cleanup)?;
        }
        self.status()
            .await
            .filter(|s| s.session_id == id)
            .ok_or(LoginError::Cancelled)
    }

    pub async fn shutdown(&self) {
        if let Some(status) = self.status().await {
            let _ = self.cancel(&status.session_id).await;
        }
    }

    pub async fn auth_url(&self, id: &str) -> Result<String, LoginError> {
        let current = self.inner.lock().await;
        current
            .as_ref()
            .filter(|s| {
                s.status.session_id == id && s.status.phase == Phase::Waiting && !*s.cancel.borrow()
            })
            .and_then(|s| s.auth_url.clone())
            .ok_or(LoginError::Cancelled)
    }

    async fn waiting(&self, id: &str, url: String) -> Result<(), LoginError> {
        let mut current = self.inner.lock().await;
        let session = current
            .as_mut()
            .filter(|s| s.status.session_id == id && !*s.cancel.borrow())
            .ok_or(LoginError::Cancelled)?;
        session.auth_url = Some(url);
        session.status.phase = Phase::Waiting;
        Ok(())
    }
}

fn root_dir(manager: &AccountManager) -> Result<PathBuf, LoginError> {
    Ok(manager
        .vault_path()
        .parent()
        .ok_or(LoginError::Storage)?
        .join("login-sessions"))
}

fn create_home(manager: &AccountManager) -> Result<tempfile::TempDir, LoginError> {
    let root = root_dir(manager)?;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&root).map_err(|_| LoginError::Storage)?;
    if fs::symlink_metadata(&root)
        .map_err(|_| LoginError::Storage)?
        .file_type()
        .is_symlink()
    {
        return Err(LoginError::Storage);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .map_err(|_| LoginError::Storage)?;
    }
    cleanup_stale(manager);
    let home = tempfile::Builder::new()
        .prefix("session-")
        .tempdir_in(root)
        .map_err(|_| LoginError::Storage)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(home.path(), fs::Permissions::from_mode(0o700))
            .map_err(|_| LoginError::Storage)?;
    }
    Ok(home)
}

// 仅清理私有根目录内超过一天的会话，避开其他正在运行的应用实例。
pub fn cleanup_stale(manager: &AccountManager) {
    let Ok(root) = root_dir(manager) else {
        return;
    };
    if !fs::symlink_metadata(&root).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with("session-") {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if meta.is_dir()
            && !meta.file_type().is_symlink()
            && meta
                .modified()
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .is_some_and(|age| age > Duration::from_secs(86400))
        {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn login_command(executable: &Path, home: &Path, settings: &proxy::ProxySettings) -> Command {
    let mut cmd = Command::new(executable);
    cmd.args([
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        "cli_auth_credentials_store=\"file\"",
        "-c",
        "analytics.enabled=false",
        "-c",
        "otel.exporter=\"none\"",
    ])
    .env("CODEX_HOME", home)
    .current_dir(home)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .kill_on_drop(true);
    for name in [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "CODEX_ACCESS_TOKEN",
        "OPENAI_BASE_URL",
        "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
    ] {
        cmd.env_remove(name);
    }
    codex_app_server::apply_proxy_env(&mut cmd, settings);
    cmd
}

fn spawn(home: &Path) -> Result<Child, LoginError> {
    let settings = proxy::get().map_err(|_| LoginError::Network)?;
    for executable in codex_app_server::codex_executables() {
        if let Ok(child) = login_command(&executable, home, &settings).spawn() {
            return Ok(child);
        }
    }
    Err(LoginError::Unavailable)
}

struct Rpc {
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    pending: VecDeque<Value>,
    login_id: Option<String>,
}

impl Rpc {
    fn take(child: &mut Child) -> Result<Self, LoginError> {
        Ok(Self {
            input: child.stdin.take().ok_or(LoginError::Unavailable)?,
            output: BufReader::new(child.stdout.take().ok_or(LoginError::Unavailable)?),
            pending: VecDeque::new(),
            login_id: None,
        })
    }

    async fn write(&mut self, message: Value) -> Result<(), LoginError> {
        let mut bytes = serde_json::to_vec(&message).map_err(|_| LoginError::InvalidResponse)?;
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|_| LoginError::Unavailable)?;
        self.input
            .flush()
            .await
            .map_err(|_| LoginError::Unavailable)
    }

    async fn read(&mut self) -> Result<Value, LoginError> {
        // 不使用无界 read_line；任何超长/畸形消息只返回固定错误码。
        let mut bytes = Vec::new();
        loop {
            let chunk = self
                .output
                .fill_buf()
                .await
                .map_err(|_| LoginError::Unavailable)?;
            if chunk.is_empty() {
                return Err(LoginError::Unavailable);
            }
            let end = chunk.iter().position(|c| *c == b'\n');
            let count = end.map_or(chunk.len(), |i| i + 1);
            if bytes.len() + count > MAX_MESSAGE {
                return Err(LoginError::InvalidResponse);
            }
            bytes.extend_from_slice(&chunk[..count]);
            self.output.consume(count);
            if end.is_some() {
                return serde_json::from_slice(&bytes).map_err(|_| LoginError::InvalidResponse);
            }
        }
    }

    async fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, LoginError> {
        let mut trace = Trace::start(match method {
            "initialize" => Operation::HostedInitialize,
            "account/login/start" => Operation::HostedLogin,
            _ => Operation::HostedAccount,
        });
        let result = timeout(RPC_TIMEOUT, async {
            self.write(json!({"id":id,"method":method,"params":params}))
                .await?;
            loop {
                let message = self.read().await?;
                if message.get("id").and_then(Value::as_u64) == Some(id) {
                    if let Some(error) = message.get("error") {
                        trace.finish(Outcome::RpcError, Some(&json!({"error":error})));
                        return Err(classify_error(error));
                    }
                    trace.finish(
                        if message.get("result").is_some() {
                            Outcome::Success
                        } else {
                            Outcome::InvalidResponse
                        },
                        message.get("result"),
                    );
                    return message
                        .get("result")
                        .cloned()
                        .ok_or(LoginError::InvalidResponse);
                }
                if message.get("method").and_then(Value::as_str) == Some("account/login/completed")
                {
                    if self.pending.len() >= MAX_PENDING {
                        return Err(LoginError::InvalidResponse);
                    }
                    self.pending.push_back(message);
                }
            }
        })
        .await
        .map_err(|_| LoginError::Network);
        trace.finish(
            match &result {
                Err(_) => Outcome::Timeout,
                Ok(Err(LoginError::InvalidResponse)) => Outcome::InvalidResponse,
                Ok(Err(_)) => Outcome::RpcError,
                Ok(Ok(_)) => Outcome::Success,
            },
            None,
        );
        result?
    }

    async fn authorize(
        &mut self,
        state: &HostedLoginState,
        id: &str,
    ) -> Result<Option<String>, LoginError> {
        self.request(0, "initialize", json!({"clientInfo":{"name":"codex_auth_switch","title":"Codex Auth Switch","version":env!("CARGO_PKG_VERSION")}})).await?;
        self.write(json!({"method":"initialized","params":{}}))
            .await?;
        let result = self
            .request(1, "account/login/start", json!({"type":"chatgpt"}))
            .await?;
        if result.get("type").and_then(Value::as_str) != Some("chatgpt") {
            return Err(LoginError::Unsupported);
        }
        let login_id = result
            .get("loginId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() < 256)
            .ok_or(LoginError::InvalidResponse)?
            .to_owned();
        self.login_id = Some(login_id.clone());
        let url = result
            .get("authUrl")
            .and_then(Value::as_str)
            .ok_or(LoginError::InvalidResponse)?;
        validate_url(url)?;
        state.waiting(id, url.to_owned()).await?;
        loop {
            let message = match self.pending.pop_front() {
                Some(message) => message,
                None => self.read().await?,
            };
            if let Some(result) = completion(&message, &login_id) {
                result?;
                break;
            }
        }
        let account = self
            .request(2, "account/read", json!({"refreshToken":false}))
            .await?;
        let account = account.get("account").ok_or(LoginError::InvalidResponse)?;
        if account.get("type").and_then(Value::as_str) != Some("chatgpt") {
            return Err(LoginError::InvalidResponse);
        }
        Ok(account
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_owned))
    }
}

fn completion(message: &Value, id: &str) -> Option<Result<(), LoginError>> {
    if message.get("method").and_then(Value::as_str) != Some("account/login/completed") {
        return None;
    }
    let params = message.get("params")?;
    if params.get("loginId").and_then(Value::as_str) != Some(id) {
        return None;
    }
    Some(match params.get("success").and_then(Value::as_bool) {
        Some(true) => Ok(()),
        Some(false) => Err(classify_error(params.get("error").unwrap_or(&Value::Null))),
        None => Err(LoginError::InvalidResponse),
    })
}

fn classify_error(error: &Value) -> LoginError {
    let text = error
        .as_str()
        .or_else(|| error.get("message").and_then(Value::as_str))
        .unwrap_or("")
        .to_ascii_lowercase();
    if error.get("code").and_then(Value::as_i64) == Some(-32601) || text.contains("unknown variant")
    {
        LoginError::Unsupported
    } else if text.contains("address already in use")
        || text.contains("port") && text.contains("in use")
    {
        LoginError::PortInUse
    } else if text.contains("429") || text.contains("rate limit") {
        LoginError::RateLimited
    } else if text.contains("timed out") || text.contains("connection") || text.contains("network")
    {
        LoginError::Network
    } else {
        LoginError::Rejected
    }
}

fn validate_url(value: &str) -> Result<(), LoginError> {
    let url = reqwest::Url::parse(value).map_err(|_| LoginError::InvalidResponse)?;
    if value.len() > 32768
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || !matches!(url.host_str(), Some("auth.openai.com" | "chatgpt.com"))
    {
        return Err(LoginError::InvalidResponse);
    }
    Ok(())
}

async fn run_login(
    state: &HostedLoginState,
    id: &str,
    home: &tempfile::TempDir,
    cancelled: watch::Receiver<bool>,
    spawn_process: impl FnOnce(&Path) -> Result<Child, LoginError>,
) -> Result<Value, LoginError> {
    crate::diagnostic_log::scope(async {
        let mut trace = Trace::start(Operation::HostedResult);
        let result = run_login_inner(state, id, home, cancelled, spawn_process).await;
        trace.finish(
            match &result {
                Ok(_) => Outcome::Success,
                Err(LoginError::Unavailable) => Outcome::Unavailable,
                Err(LoginError::Unsupported) => Outcome::Unsupported,
                Err(LoginError::PortInUse) => Outcome::PortInUse,
                Err(LoginError::Network) => Outcome::Network,
                Err(LoginError::RateLimited) => Outcome::RateLimited,
                Err(LoginError::Rejected) => Outcome::Rejected,
                Err(LoginError::InvalidResponse) => Outcome::InvalidResponse,
                Err(LoginError::Storage) => Outcome::Storage,
                Err(LoginError::Expired) => Outcome::Expired,
                Err(LoginError::Cancelled) => Outcome::Cancelled,
                Err(LoginError::Cleanup) => Outcome::Cleanup,
                Err(_) => Outcome::RpcError,
            },
            None,
        );
        result
    })
    .await
}

async fn run_login_inner(
    state: &HostedLoginState,
    id: &str,
    home: &tempfile::TempDir,
    mut cancelled: watch::Receiver<bool>,
    spawn_process: impl FnOnce(&Path) -> Result<Child, LoginError>,
) -> Result<Value, LoginError> {
    if *cancelled.borrow() {
        return Err(LoginError::Cancelled);
    }
    let mut child = spawn_process(home.path())?;
    let result = exchange(&mut child, state, id, &mut cancelled, LOGIN_TIMEOUT).await;
    stop(&mut child).await?;
    let email = result?;
    if *cancelled.borrow() {
        return Err(LoginError::Cancelled);
    }
    read_auth(home.path(), email.as_deref())
}

async fn exchange(
    child: &mut Child,
    state: &HostedLoginState,
    id: &str,
    cancelled: &mut watch::Receiver<bool>,
    login_timeout: Duration,
) -> Result<Option<String>, LoginError> {
    let mut rpc = Rpc::take(child)?;
    let result = {
        let authorize = Box::pin(timeout(login_timeout, rpc.authorize(state, id)));
        let cancel = Box::pin(cancelled.changed());
        match select(cancel, authorize).await {
            Either::Left(_) => Err(LoginError::Cancelled),
            Either::Right((result, _)) => result.unwrap_or(Err(LoginError::Expired)),
        }
    };
    if result.is_err() {
        if let Some(login_id) = rpc.login_id.clone() {
            // 仅取消这次待授权会话；绝不调用 account/logout。
            let _ = timeout(
                Duration::from_secs(1),
                rpc.write(
                    json!({"id":3,"method":"account/login/cancel","params":{"loginId":login_id}}),
                ),
            )
            .await;
        }
    }
    result
}

async fn stop(child: &mut Child) -> Result<(), LoginError> {
    if child.try_wait().map_err(|_| LoginError::Cleanup)?.is_none() {
        child.start_kill().map_err(|_| LoginError::Cleanup)?;
    }
    timeout(STOP_TIMEOUT, child.wait())
        .await
        .map_err(|_| LoginError::Cleanup)?
        .map_err(|_| LoginError::Cleanup)?;
    Ok(())
}

fn read_auth(home: &Path, expected_email: Option<&str>) -> Result<Value, LoginError> {
    let path = home.join("auth.json");
    let meta = fs::symlink_metadata(&path).map_err(|_| LoginError::InvalidResponse)?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(LoginError::InvalidResponse);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| LoginError::Storage)?
        .take((MAX_MESSAGE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| LoginError::Storage)?;
    if bytes.len() > MAX_MESSAGE {
        return Err(LoginError::InvalidResponse);
    }
    let auth: Value = serde_json::from_slice(&bytes).map_err(|_| LoginError::InvalidResponse)?;
    let identity = validate_chatgpt_auth(&auth).map_err(|_| LoginError::InvalidResponse)?;
    if expected_email
        .zip(identity.email.as_deref())
        .is_some_and(|(expected, actual)| !expected.eq_ignore_ascii_case(actual))
    {
        return Err(LoginError::InvalidResponse);
    }
    Ok(auth)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_auth() -> Value {
        json!({"auth_mode":"chatgpt","tokens":{"account_id":"test-account","access_token":"synthetic-access","refresh_token":"synthetic-refresh"}})
    }

    #[test]
    fn credentials_are_validated_and_never_exposed_by_status_or_errors() {
        let root = tempfile::TempDir::new().unwrap();
        fs::write(
            root.path().join("auth.json"),
            serde_json::to_vec(&synthetic_auth()).unwrap(),
        )
        .unwrap();
        assert!(read_auth(root.path(), None).is_ok());
        fs::write(
            root.path().join("auth.json"),
            r#"{"auth_mode":"apikey","OPENAI_API_KEY":"synthetic-secret"}"#,
        )
        .unwrap();
        assert!(matches!(
            read_auth(root.path(), None),
            Err(LoginError::InvalidResponse)
        ));
        fs::write(root.path().join("auth.json"), vec![b'a'; MAX_MESSAGE + 1]).unwrap();
        assert!(matches!(
            read_auth(root.path(), None),
            Err(LoginError::InvalidResponse)
        ));
        for (error, expected) in [
            (
                json!({"code":-32601,"message":"synthetic-secret"}),
                LoginError::Unsupported,
            ),
            (
                json!("address already in use: synthetic-secret"),
                LoginError::PortInUse,
            ),
            (json!("429 synthetic-secret"), LoginError::RateLimited),
            (
                json!("connection failed synthetic-secret"),
                LoginError::Network,
            ),
            (json!("synthetic-secret"), LoginError::Rejected),
        ] {
            let classified = classify_error(&error);
            assert_eq!(classified, expected);
            assert!(!serde_json::to_string(&classified)
                .unwrap()
                .contains("synthetic-secret"));
        }
    }

    #[test]
    fn authorization_urls_and_completion_ids_are_checked() {
        assert!(validate_url("https://auth.openai.com/oauth/authorize?state=test").is_ok());
        for url in [
            "http://auth.openai.com/",
            "https://auth.openai.com.evil.invalid/",
            "https://user@auth.openai.com/",
            "https://auth.openai.com:444/",
            "file:///tmp/auth.json",
            "javascript:alert(1)",
        ] {
            assert_eq!(validate_url(url), Err(LoginError::InvalidResponse));
        }
        let done =
            json!({"method":"account/login/completed","params":{"loginId":"new","success":true}});
        assert!(completion(&done, "old").is_none());
        assert_eq!(completion(&done, "new"), Some(Ok(())));
    }

    #[cfg(unix)]
    fn fake(script: &str, home: &Path) -> Child {
        Command::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .env("CODEX_HOME", home)
            .current_dir(home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    }

    #[cfg(unix)]
    const SUCCESS: &str = r#"
read -r initialize
printf '%s\n' '{"id":0,"result":{"userAgent":"test"}}'
read -r initialized
read -r start
umask 077
printf '%s' '{"auth_mode":"chatgpt","tokens":{"account_id":"test-account","access_token":"synthetic-access","refresh_token":"synthetic-refresh"}}' > "$CODEX_HOME/auth.json"
printf '%s\n' '{"method":"account/login/completed","params":{"loginId":"wrong","success":false}}'
printf '%s\n' '{"method":"account/login/completed","params":{"loginId":"official-id","success":true}}'
printf '%s\n' '{"id":1,"result":{"type":"chatgpt","loginId":"official-id","authUrl":"https://auth.openai.com/oauth/authorize?state=synthetic-secret"}}'
printf '%s\n' '{"method":"account/login/completed","params":{"loginId":"official-id","success":true}}'
read -r account
printf '%s\n' '{"id":2,"result":{"account":{"type":"chatgpt","email":null,"planType":"plus"}}}'
while read -r remaining; do :; done
"#;

    #[cfg(unix)]
    const WAITING: &str = r#"
read -r initialize
printf '%s\n' '{"id":0,"result":{}}'
read -r initialized
read -r start
printf '%s\n' '{"id":1,"result":{"type":"chatgpt","loginId":"official-id","authUrl":"https://auth.openai.com/oauth/authorize"}}'
while read -r remaining; do :; done
"#;

    async fn finished(state: &HostedLoginState) -> LoginStatus {
        let mut done = state.inner.lock().await.as_ref().unwrap().done.clone();
        timeout(Duration::from_secs(5), async {
            while !*done.borrow_and_update() {
                done.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        state.status().await.unwrap()
    }

    #[test]
    #[cfg(unix)]
    fn early_and_duplicate_notifications_save_once_and_clean_the_process_home() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::TempDir::new().unwrap();
            let manager =
                AccountManager::new(root.path().join("real-home"), root.path().join("vault"));
            let state = HostedLoginState::default();
            let initial = state
                .start_with(
                    manager.clone(),
                    "测试账号".into(),
                    Arc::new(Mutex::new(())),
                    Arc::new(QueryGate::default()),
                    |home| Ok(fake(SUCCESS, home)),
                )
                .await
                .unwrap();
            let status = finished(&state).await;
            assert_eq!(status.phase, Phase::Completed);
            assert!(!status.cleanup_pending);
            assert_eq!(manager.status().unwrap().accounts.len(), 1);
            assert!(manager.status().unwrap().active_account_id.is_none());
            assert!(!manager.codex_home_path().exists());
            assert!(!root_dir(&manager)
                .unwrap()
                .join(&initial.session_id)
                .exists());
            let wire = serde_json::to_string(&status).unwrap();
            for forbidden in [
                "synthetic-secret",
                "refresh_token",
                "authUrl",
                "official-id",
            ] {
                assert!(!wire.contains(forbidden));
            }
            // 已提交的取消必须返回真实成功，不能删除已保存账号。
            assert_eq!(
                state.cancel(&initial.session_id).await.unwrap().phase,
                Phase::Completed
            );
        });
    }

    #[test]
    #[cfg(unix)]
    fn cancel_stops_waiting_login_and_prevents_late_commit() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::TempDir::new().unwrap();
            let manager =
                AccountManager::new(root.path().join("real-home"), root.path().join("vault"));
            let state = HostedLoginState::default();
            let initial = state
                .start_with(
                    manager.clone(),
                    "测试账号".into(),
                    Arc::new(Mutex::new(())),
                    Arc::new(QueryGate::default()),
                    |home| Ok(fake(WAITING, home)),
                )
                .await
                .unwrap();
            assert!(state.active().await);
            assert!(matches!(
                state
                    .start_with(
                        manager.clone(),
                        "重复".into(),
                        Arc::new(Mutex::new(())),
                        Arc::new(QueryGate::default()),
                        |_| panic!("重复会话不得启动进程")
                    )
                    .await,
                Err(LoginError::Busy)
            ));
            let cancelled = state.cancel(&initial.session_id).await.unwrap();
            assert_eq!(cancelled.phase, Phase::Cancelled);
            assert!(!cancelled.cleanup_pending);
            assert!(!manager.vault_path().exists());
            assert!(!root_dir(&manager)
                .unwrap()
                .join(initial.session_id)
                .exists());
            let next = state
                .start_with(
                    manager.clone(),
                    "新会话".into(),
                    Arc::new(Mutex::new(())),
                    Arc::new(QueryGate::default()),
                    |home| Ok(fake(WAITING, home)),
                )
                .await
                .unwrap();
            assert!(matches!(
                state.cancel("stale-id").await,
                Err(LoginError::Cancelled)
            ));
            assert!(state.active().await);
            state.cancel(&next.session_id).await.unwrap();
        });
    }

    #[test]
    #[cfg(unix)]
    fn cancellation_does_not_wait_for_an_unrelated_quota_query() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::TempDir::new().unwrap();
            let manager =
                AccountManager::new(root.path().join("real-home"), root.path().join("vault"));
            let queries = Arc::new(QueryGate::default());
            let _held = queries.acquire("other-account").await;
            let state = HostedLoginState::default();
            let initial = state
                .start_with(
                    manager.clone(),
                    "测试账号".into(),
                    Arc::new(Mutex::new(())),
                    queries.clone(),
                    |home| Ok(fake(SUCCESS, home)),
                )
                .await
                .unwrap();
            // 等待官方进程已产生凭据，提交仍被查询锁阻塞。
            let path = root_dir(&manager)
                .unwrap()
                .join(&initial.session_id)
                .join("auth.json");
            timeout(Duration::from_secs(3), async {
                while !path.exists() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            let status = timeout(Duration::from_secs(2), state.cancel(&initial.session_id))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(status.phase, Phase::Cancelled);
            assert!(!manager.vault_path().exists());
        });
    }

    #[test]
    #[cfg(unix)]
    fn failed_runtime_cleans_up_and_timeout_reaps_the_child() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::TempDir::new().unwrap();
            let manager =
                AccountManager::new(root.path().join("real-home"), root.path().join("vault"));
            let state = HostedLoginState::default();
            let initial = state.start_with(manager.clone(), "测试账号".into(), Arc::new(Mutex::new(())), Arc::new(QueryGate::default()), |home| Ok(fake("read -r init; printf '%s\\n' '{\"id\":0,\"error\":{\"code\":-32601,\"message\":\"synthetic-secret\"}}'", home))).await.unwrap();
            let status = finished(&state).await;
            assert_eq!(status.phase, Phase::Failed);
            assert_eq!(status.error, Some(LoginError::Unsupported));
            assert!(!root_dir(&manager)
                .unwrap()
                .join(initial.session_id)
                .exists());
            assert!(!manager.vault_path().exists());
            let mut child = fake("read -r init; read -r another", root.path());
            let (_tx, mut rx) = watch::channel(false);
            assert_eq!(
                exchange(
                    &mut child,
                    &state,
                    "unused",
                    &mut rx,
                    Duration::from_millis(30)
                )
                .await,
                Err(LoginError::Expired)
            );
            stop(&mut child).await.unwrap();
            assert!(child.try_wait().unwrap().is_some());
        });
    }

    #[test]
    #[cfg(unix)]
    fn temporary_homes_are_private_and_symlinks_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::TempDir::new().unwrap();
        let manager = AccountManager::new(root.path().join("real-home"), root.path().join("vault"));
        let home = create_home(&manager).unwrap();
        assert_eq!(
            fs::metadata(home.path()).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let external = root.path().join("external-auth");
        fs::write(&external, "do not delete").unwrap();
        symlink(&external, home.path().join("auth.json")).unwrap();
        assert!(matches!(
            read_auth(home.path(), None),
            Err(LoginError::InvalidResponse)
        ));
        home.close().unwrap();
        assert!(external.exists());
        fs::remove_dir(root_dir(&manager).unwrap()).unwrap();
        symlink(root.path(), root_dir(&manager).unwrap()).unwrap();
        assert!(matches!(create_home(&manager), Err(LoginError::Storage)));
        cleanup_stale(&manager);
        assert!(external.exists());
    }
}
