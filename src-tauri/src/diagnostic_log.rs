//! Opt-in local request diagnostics. Raw requests, credentials, headers, URLs and
//! free-form server messages never cross this module's persistence/IPC boundary.
use crate::{proxy, storage};
use reqwest::{header::HeaderMap, RequestBuilder, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs::{self, File},
    future::Future,
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

const MAX_ENTRIES: usize = 500;
const MAX_BYTES: usize = 1024 * 1024;
const BODY_LIMIT: usize = 64 * 1024;
const RETENTION_DAYS: u64 = 7;
const FILE_NAME: &str = "diagnostic-logs.v1.json";
const EXPORT_NAME: &str = "diagnostics/diagnostic-log-export.json";
static STORE: OnceLock<Arc<Mutex<LogStore>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
tokio::task_local! { static GROUP: u64; }

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    DeviceCode,
    DevicePoll,
    OAuthExchange,
    OAuthRefresh,
    QuotaUsage,
    QuotaCredits,
    AppServerQuery,
    RpcInitialize,
    RpcAccount,
    RpcLimits,
    RpcUsage,
    HostedInitialize,
    HostedLogin,
    HostedAccount,
    HostedResult,
}

#[derive(Clone, Default, Serialize)]
pub struct RequestInfo {
    method: &'static str,
    target: &'static str,
}

impl Operation {
    fn request(self) -> RequestInfo {
        let (method, target) = match self {
            Self::DeviceCode => (
                "POST",
                "https://auth.openai.com/api/accounts/deviceauth/usercode",
            ),
            Self::DevicePoll => (
                "POST",
                "https://auth.openai.com/api/accounts/deviceauth/token",
            ),
            Self::OAuthExchange | Self::OAuthRefresh => {
                ("POST", "https://auth.openai.com/oauth/token")
            }
            Self::QuotaUsage => ("GET", "https://chatgpt.com/backend-api/wham/usage"),
            Self::QuotaCredits => (
                "GET",
                "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
            ),
            Self::AppServerQuery => ("PROCESS", "codex app-server"),
            Self::RpcInitialize | Self::HostedInitialize => ("RPC", "initialize"),
            Self::RpcAccount | Self::HostedAccount => ("RPC", "account/read"),
            Self::RpcLimits => ("RPC", "account/rateLimits/read"),
            Self::RpcUsage => ("RPC", "account/usage/read"),
            Self::HostedLogin => ("RPC", "account/login/start"),
            Self::HostedResult => ("PROCESS", "codex app-server (login)"),
        };
        RequestInfo { method, target }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Success,
    HttpError,
    Timeout,
    Connect,
    Network,
    InvalidResponse,
    RpcError,
    RateLimited,
    Unavailable,
    Interrupted,
    Unsupported,
    PortInUse,
    Rejected,
    Storage,
    Expired,
    Cancelled,
    Cleanup,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BodyKind {
    #[default]
    None,
    Json,
    Html,
    Text,
    Other,
    TooLarge,
    Unreadable,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: u64,
    group: u64,
    time: u64,
    operation: Operation,
    #[serde(skip_deserializing)]
    request: RequestInfo,
    attempt: u32,
    duration_ms: u64,
    proxy_mode: Option<proxy::ProxyMode>,
    status: Option<u16>,
    outcome: Outcome,
    body_kind: BodyKind,
    response: Value,
}

#[derive(Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Warning {
    Read,
    Write,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    enabled: bool,
    entries: Vec<Entry>,
    warning: Option<Warning>,
    max_entries: usize,
    max_bytes: usize,
    retention_days: u64,
    app_version: &'static str,
    platform: &'static str,
}

#[derive(Deserialize)]
struct DiskLog {
    version: u32,
    entries: Vec<Entry>,
}

#[derive(Serialize)]
struct DiskLogRef<'a> {
    version: u32,
    entries: &'a [Entry],
}

struct LogStore {
    directory: PathBuf,
    enabled: bool,
    generation: u64,
    entries: Vec<Entry>,
    warning: Option<Warning>,
}

fn now() -> u64 {
    chrono::Utc::now().timestamp().max(0) as u64
}

impl LogStore {
    fn open(directory: PathBuf) -> Self {
        let mut store = Self {
            directory,
            enabled: false,
            generation: 0,
            entries: vec![],
            warning: None,
        };
        let read = (|| {
            let file = match File::open(store.directory.join(FILE_NAME)) {
                Ok(file) => file,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
                Err(_) => return Err(()),
            };
            let mut bytes = Vec::new();
            file.take((MAX_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| ())?;
            if bytes.len() > MAX_BYTES {
                return Err(());
            }
            let disk: DiskLog = serde_json::from_slice(&bytes).map_err(|_| ())?;
            if disk.version != 1 {
                return Err(());
            }
            Ok(disk.entries)
        })();
        match read {
            Ok(mut entries) => {
                // Treat disk contents as untrusted too; never export unknown fields.
                for entry in &mut entries {
                    entry.response = safe_response(&entry.response);
                    entry.request = entry.operation.request();
                }
                store.entries = entries;
                store.prune();
                if store.directory.join(FILE_NAME).exists() {
                    store.persist();
                }
            }
            Err(()) => store.warning = Some(Warning::Read),
        }
        store
    }

    fn prune(&mut self) {
        let time = now();
        self.entries
            .retain(|e| e.time <= time && time.saturating_sub(e.time) <= RETENTION_DAYS * 86400);
        if self.entries.len() > MAX_ENTRIES {
            self.entries.drain(..self.entries.len() - MAX_ENTRIES);
        }
        let sizes: Vec<usize> = self
            .entries
            .iter()
            .map(|entry| serde_json::to_vec(entry).map_or(MAX_BYTES, |bytes| bytes.len() + 1))
            .collect();
        // Empty envelope plus one comma allowance per entry is a conservative bound.
        let mut total = 32 + sizes.iter().sum::<usize>();
        let mut remove = 0;
        while total > MAX_BYTES && remove < sizes.len() {
            total -= sizes[remove];
            remove += 1;
        }
        self.entries.drain(..remove);
    }

    fn bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(&DiskLogRef {
            version: 1,
            entries: &self.entries,
        })
    }

    fn persist(&mut self) {
        let result = self.bytes().map_err(|_| ()).and_then(|bytes| {
            storage::atomic_write(&self.directory.join(FILE_NAME), &bytes).map_err(|_| ())
        });
        self.warning = result.err().map(|_| Warning::Write);
    }

    fn snapshot(&mut self) -> Snapshot {
        let previous = self.entries.len();
        self.prune();
        if previous != self.entries.len() {
            self.persist();
        }
        Snapshot {
            enabled: self.enabled,
            entries: self.entries.clone(),
            warning: self.warning,
            max_entries: MAX_ENTRIES,
            max_bytes: MAX_BYTES,
            retention_days: RETENTION_DAYS,
            app_version: env!("CARGO_PKG_VERSION"),
            platform: std::env::consts::OS,
        }
    }

    fn set_enabled(&mut self, enabled: bool) -> Result<Snapshot, String> {
        if enabled && self.warning == Some(Warning::Read) {
            return Err("诊断日志无法读取，请先清空日志".into());
        }
        if self.enabled != enabled {
            self.generation += 1;
        }
        self.enabled = enabled;
        Ok(self.snapshot())
    }

    fn record(&mut self, generation: u64, entry: Entry) {
        if !self.enabled || generation != self.generation {
            return;
        }
        self.entries.push(entry);
        self.prune();
        self.persist();
    }

    fn clear(&mut self) -> Result<Snapshot, String> {
        // Also invalidate requests already in flight, even if logging remains on.
        self.generation += 1;
        self.entries.clear();
        let mut failed = false;
        for name in [FILE_NAME, EXPORT_NAME] {
            if let Err(error) = fs::remove_file(self.directory.join(name)) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    failed = true;
                }
            }
        }
        self.warning = failed.then_some(Warning::Write);
        if failed {
            return Err("清空诊断日志失败".into());
        }
        Ok(self.snapshot())
    }

    fn export(&mut self) -> Result<PathBuf, String> {
        let bytes = serde_json::to_vec_pretty(&self.snapshot()).map_err(|_| "导出诊断日志失败")?;
        let path = self.directory.join(EXPORT_NAME);
        storage::atomic_write(&path, &bytes).map_err(|_| "导出诊断日志失败")?;
        Ok(path)
    }
}

pub fn init(directory: PathBuf) {
    let store = LogStore::open(directory);
    NEXT_ID.store(
        store
            .entries
            .iter()
            .map(|e| e.id.max(e.group))
            .max()
            .unwrap_or(0)
            .saturating_add(1),
        Ordering::Relaxed,
    );
    let _ = STORE.set(Arc::new(Mutex::new(store)));
}

fn with_store<T>(action: impl FnOnce(&mut LogStore) -> Result<T, String>) -> Result<T, String> {
    let mut store = STORE
        .get()
        .ok_or("诊断日志尚未初始化")?
        .lock()
        .map_err(|_| "无法访问诊断日志")?;
    action(&mut store)
}

pub fn snapshot() -> Result<Snapshot, String> {
    with_store(|s| Ok(s.snapshot()))
}
pub fn set_enabled(enabled: bool) -> Result<Snapshot, String> {
    with_store(|s| s.set_enabled(enabled))
}
pub fn clear() -> Result<Snapshot, String> {
    with_store(LogStore::clear)
}

pub fn export() -> Result<PathBuf, String> {
    with_store(LogStore::export)
}

pub async fn scope<T>(future: impl Future<Output = T>) -> T {
    GROUP
        .scope(NEXT_ID.fetch_add(1, Ordering::Relaxed), future)
        .await
}

pub struct Trace {
    store: Option<Arc<Mutex<LogStore>>>,
    stamp: Option<(u64, u64, u64)>,
    started: Instant,
    time: u64,
    operation: Operation,
    attempt: u32,
    status: Option<u16>,
    body_kind: BodyKind,
    proxy_mode: Option<proxy::ProxyMode>,
}

impl Trace {
    pub fn start(operation: Operation) -> Self {
        Self::with_store(operation, STORE.get().cloned())
    }

    fn with_store(operation: Operation, store: Option<Arc<Mutex<LogStore>>>) -> Self {
        let stamp = store.as_ref().and_then(|s| s.lock().ok()).and_then(|s| {
            s.enabled.then(|| {
                let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
                (
                    s.generation,
                    id,
                    GROUP.try_with(|group| *group).unwrap_or(id),
                )
            })
        });
        Self {
            store,
            stamp,
            started: Instant::now(),
            time: now(),
            operation,
            attempt: 1,
            status: None,
            body_kind: BodyKind::None,
            proxy_mode: stamp.and_then(|_| proxy::get().ok().map(|s| s.mode)),
        }
    }

    pub fn finish(&mut self, outcome: Outcome, response: Option<&Value>) {
        let Some((generation, id, group)) = self.stamp.take() else {
            return;
        };
        if response.is_some() {
            self.body_kind = BodyKind::Json;
        }
        let entry = Entry {
            id,
            group,
            time: self.time,
            operation: self.operation,
            request: self.operation.request(),
            attempt: self.attempt,
            duration_ms: self.started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            proxy_mode: self.proxy_mode,
            status: self.status,
            outcome,
            body_kind: self.body_kind,
            response: response.map(safe_response).unwrap_or(Value::Null),
        };
        if let Some(mut store) = self.store.as_ref().and_then(|s| s.lock().ok()) {
            store.record(generation, entry);
        }
    }
}

impl Drop for Trace {
    fn drop(&mut self) {
        self.finish(Outcome::Interrupted, None);
    }
}

fn network_outcome(error: &reqwest::Error) -> Outcome {
    if error.is_timeout() {
        Outcome::Timeout
    } else if error.is_connect() {
        Outcome::Connect
    } else {
        Outcome::Network
    }
}

// The wrapper observes the same response consumed by the business code. There
// are no extra network requests and no request-body/header logging hooks.
pub struct LoggedResponse {
    response: reqwest::Response,
    trace: Trace,
}

pub async fn send(
    request: RequestBuilder,
    operation: Operation,
    attempt: u32,
) -> Result<LoggedResponse, reqwest::Error> {
    let mut trace = Trace::start(operation);
    trace.attempt = attempt;
    send_with_trace(request, trace).await
}

async fn send_with_trace(
    request: RequestBuilder,
    mut trace: Trace,
) -> Result<LoggedResponse, reqwest::Error> {
    match request.send().await {
        Ok(response) => {
            trace.status = Some(response.status().as_u16());
            trace.body_kind = match response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.split(';').next())
                .map(str::trim)
            {
                Some("application/json") => BodyKind::Json,
                Some("text/html") => BodyKind::Html,
                Some("text/plain") => BodyKind::Text,
                _ => BodyKind::Other,
            };
            Ok(LoggedResponse { response, trace })
        }
        Err(error) => {
            trace.finish(network_outcome(&error), None);
            Err(error)
        }
    }
}

impl LoggedResponse {
    pub fn status(&self) -> StatusCode {
        self.response.status()
    }
    pub fn headers(&self) -> &HeaderMap {
        self.response.headers()
    }

    pub async fn json<T: DeserializeOwned>(self) -> Result<T, ()> {
        let Self {
            response,
            mut trace,
        } = self;
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                trace.finish(network_outcome(&error), None);
                return Err(());
            }
        };
        let result = serde_json::from_slice::<T>(&bytes).map_err(|_| ());
        let diagnostic = if trace.stamp.is_some() && bytes.len() <= BODY_LIMIT {
            serde_json::from_slice::<Value>(&bytes).ok()
        } else {
            None
        };
        if bytes.len() > BODY_LIMIT {
            trace.body_kind = BodyKind::TooLarge;
        }
        trace.finish(
            if result.is_ok() {
                Outcome::Success
            } else {
                Outcome::InvalidResponse
            },
            diagnostic.as_ref(),
        );
        result
    }

    pub async fn discard(self) {
        let Self {
            mut response,
            mut trace,
        } = self;
        if trace.stamp.is_none() {
            return;
        }
        let outcome = if response.status().is_success() {
            Outcome::Success
        } else {
            Outcome::HttpError
        };
        // Failed responses may contain OAuth secrets or HTML challenges. Read a
        // bounded sample, but persist only a complete JSON allowlist projection.
        let read = tokio::time::timeout(Duration::from_millis(500), async {
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| BodyKind::Unreadable)? {
                if bytes.len() + chunk.len() > BODY_LIMIT {
                    return Err(BodyKind::TooLarge);
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        })
        .await;
        let body = match read {
            Ok(Ok(bytes)) => serde_json::from_slice::<Value>(&bytes).ok(),
            Ok(Err(kind)) => {
                trace.body_kind = kind;
                None
            }
            Err(_) => {
                trace.body_kind = BodyKind::Unreadable;
                None
            }
        };
        trace.finish(outcome, body.as_ref());
    }
}

// Unknown fields and all arbitrary strings are omitted, including error.message.
// Filtering by *type and known value* prevents secrets hidden in innocuous fields.
fn safe_response(value: &Value) -> Value {
    fn project(value: &Value, depth: usize) -> Value {
        if depth > 6 {
            return Value::Null;
        }
        if let Some(items) = value.as_array() {
            return Value::Array(
                items
                    .iter()
                    .take(12)
                    .map(|v| project(v, depth + 1))
                    .collect(),
            );
        }
        let Some(object) = value.as_object() else {
            return Value::Null;
        };
        let mut output = Map::new();
        for (key, value) in object {
            let projected = match key.as_str() {
                "used_percent"
                | "usedPercent"
                | "window_duration_mins"
                | "windowDurationMins"
                | "reset_at"
                | "resetsAt"
                | "reset_after_seconds"
                | "limit_window_seconds"
                | "available_count"
                | "availableCount"
                | "expires_in"
                | "interval"
                | "lifetimeTokens"
                | "peakDailyTokens"
                | "longestRunningTurnSec"
                | "currentStreakDays"
                | "longestStreakDays"
                | "tokens" => value.as_number().map(|n| Value::Number(n.clone())),
                "allowed" | "limit_reached" | "success" | "is_supported_by_plan" => {
                    value.as_bool().map(Value::Bool)
                }
                "code" if value.is_i64() => Some(value.clone()),
                // Coarse hints only, never the actual server message. This helps
                // diagnose App Server errors whose JSON-RPC code is generic.
                "message" | "error_description" => None,
                "messageClass" => value
                    .as_str()
                    .filter(|v| {
                        matches!(
                            *v,
                            "rateLimited"
                                | "unauthorized"
                                | "forbidden"
                                | "timeout"
                                | "connection"
                                | "unsupported"
                                | "credentialRefresh"
                        )
                    })
                    .map(|v| Value::String(v.to_owned())),
                "code" | "error" | "type" | "status" | "plan_type" | "planType" => value
                    .as_str()
                    .filter(|v| {
                        matches!(
                            *v,
                            "invalid_grant"
                                | "invalid_request"
                                | "invalid_client"
                                | "access_denied"
                                | "authorization_pending"
                                | "slow_down"
                                | "expired_token"
                                | "refresh_token_reused"
                                | "refresh_token_expired"
                                | "refresh_token_invalidated"
                                | "token_expired"
                                | "invalid_token"
                                | "rate_limit_exceeded"
                                | "server_error"
                                | "temporarily_unavailable"
                                | "insufficient_quota"
                                | "free"
                                | "plus"
                                | "pro"
                                | "team"
                                | "business"
                                | "enterprise"
                                | "edu"
                                | "chatgpt"
                                | "available"
                                | "used"
                                | "expired"
                        )
                    })
                    .map(|v| Value::String(v.to_string()))
                    .or_else(|| value.is_object().then(|| project(value, depth + 1))),
                "rate_limits_by_limit_id" | "rateLimitsByLimitId" => {
                    if let Some(map) = value.as_object() {
                        Some(Value::Array(
                            map.values()
                                .take(12)
                                .map(|v| project(v, depth + 1))
                                .collect(),
                        ))
                    } else if value.is_array() {
                        Some(project(value, depth + 1))
                    } else {
                        None
                    }
                }
                "rate_limit"
                | "rateLimits"
                | "primary_window"
                | "secondary_window"
                | "primary"
                | "secondary"
                | "rate_limit_reset_credits"
                | "rateLimitResetCredits"
                | "credits"
                | "summary"
                | "dailyUsageBuckets"
                | "account" => {
                    (value.is_object() || value.is_array()).then(|| project(value, depth + 1))
                }
                _ => None,
            };
            if let Some(projected) = projected {
                output.insert(key.clone(), projected);
            }
        }
        let message = object
            .get("message")
            .or_else(|| object.get("error_description"))
            .and_then(Value::as_str)
            .map(|s| {
                s.chars()
                    .take(2048)
                    .collect::<String>()
                    .to_ascii_lowercase()
            });
        if let Some(message) = message {
            let class = if message.contains("rate limit") || message.contains("429") {
                Some("rateLimited")
            } else if message.contains("401") || message.contains("unauthorized") {
                Some("unauthorized")
            } else if message.contains("403") || message.contains("forbidden") {
                Some("forbidden")
            } else if message.contains("refresh token") || message.contains("invalid_grant") {
                Some("credentialRefresh")
            } else if message.contains("timed out") || message.contains("timeout") {
                Some("timeout")
            } else if message.contains("connection") {
                Some("connection")
            } else if message.contains("unknown variant") || message.contains("method not found") {
                Some("unsupported")
            } else {
                None
            };
            if let Some(class) = class {
                output.insert("messageClass".into(), Value::String(class.into()));
            }
        }
        Value::Object(output)
    }
    let result = project(value, 0);
    if serde_json::to_vec(&result).map_or(true, |v| v.len() > 8192) {
        Value::Null
    } else {
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    const SECRET: &str = "SYNTHETIC_SECRET_DO_NOT_EXPORT";

    fn fixture() -> (tempfile::TempDir, Arc<Mutex<LogStore>>) {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(Mutex::new(LogStore::open(directory.path().to_owned())));
        (directory, store)
    }

    fn trace(store: &Arc<Mutex<LogStore>>) -> Trace {
        Trace::with_store(Operation::QuotaUsage, Some(store.clone()))
    }

    #[test]
    fn allowlist_removes_secrets_even_in_known_fields_and_dynamic_keys() {
        let raw = json!({
            "access_token": SECRET, "refresh_token": SECRET, "id_token": SECRET,
            "Cookie": SECRET, "authorization_code": SECRET, "device_auth_id": SECRET,
            "user_code": SECRET, "authUrl": SECRET, "loginId": SECRET,
            "email": SECRET, "account_id": SECRET,
            "error": { "code": "refresh_token_reused", "message": format!("HTTP 403 {SECRET}"), "data": SECRET },
            "rateLimitsByLimitId": { (SECRET): { "limitId": SECRET,
                "primary": { "usedPercent": 42.5, "resetsAt": 123 }, "planType": SECRET } },
            "summary": {"lifetimeTokens": 900, "peakDailyTokens": SECRET},
            "plan_type": "plus", "tokens": {"access_token": SECRET},
            "interval": SECRET, "status": SECRET, "type": SECRET
        });
        let clean = safe_response(&raw);
        assert!(!clean.to_string().contains(SECRET));
        assert_eq!(clean["error"]["code"], "refresh_token_reused");
        assert_eq!(clean["error"]["messageClass"], "forbidden");
        assert_eq!(
            clean["rateLimitsByLimitId"][0]["primary"]["usedPercent"],
            42.5
        );
        assert_eq!(clean["summary"]["lifetimeTokens"], 900);
        assert!(clean.get("interval").is_none());
        assert_eq!(safe_response(&clean), clean);
        assert_eq!(safe_response(&Value::String(SECRET.into())), Value::Null);
    }

    #[test]
    fn default_off_disable_clear_and_restart_are_collection_boundaries() {
        let (directory, store) = fixture();
        trace(&store).finish(Outcome::Success, Some(&json!({"plan_type":"plus"})));
        assert!(!directory.path().join(FILE_NAME).exists());
        let mut before_enable = trace(&store);
        store.lock().unwrap().set_enabled(true).unwrap();
        before_enable.finish(Outcome::Success, None);
        assert!(store.lock().unwrap().entries.is_empty());
        let mut before_disable = trace(&store);
        store.lock().unwrap().set_enabled(false).unwrap();
        store.lock().unwrap().set_enabled(true).unwrap();
        before_disable.finish(Outcome::Success, None);
        assert!(store.lock().unwrap().entries.is_empty());
        let mut before_clear = trace(&store);
        store.lock().unwrap().clear().unwrap();
        before_clear.finish(Outcome::Success, None);
        assert!(store.lock().unwrap().entries.is_empty());
        trace(&store).finish(
            Outcome::Success,
            Some(&json!({"plan_type":"plus", "access_token":SECRET})),
        );
        let path = store.lock().unwrap().export().unwrap();
        let exported = fs::read_to_string(&path).unwrap();
        assert!(!exported.contains(SECRET));
        assert!(exported.contains("https://chatgpt.com/backend-api/wham/usage"));
        let restarted = LogStore::open(directory.path().to_owned());
        assert!(!restarted.enabled);
        assert_eq!(restarted.entries.len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        store.lock().unwrap().clear().unwrap();
        assert!(!path.exists());
        assert!(!directory.path().join(FILE_NAME).exists());
    }

    #[test]
    fn corrupted_and_oversize_logs_fail_closed_and_clear_recovers() {
        let directory = tempfile::tempdir().unwrap();
        for bytes in [b"invalid".to_vec(), vec![b' '; MAX_BYTES + 1]] {
            fs::write(directory.path().join(FILE_NAME), &bytes).unwrap();
            let mut store = LogStore::open(directory.path().to_owned());
            assert!(matches!(store.warning, Some(Warning::Read)));
            assert!(!store.enabled);
            assert!(store.set_enabled(true).is_err());
            assert_eq!(fs::read(directory.path().join(FILE_NAME)).unwrap(), bytes);
            store.clear().unwrap();
            assert!(store.set_enabled(true).is_ok());
        }
    }

    #[test]
    fn disk_is_sanitized_again_before_viewing_or_exporting() {
        let (directory, store) = fixture();
        store.lock().unwrap().set_enabled(true).unwrap();
        trace(&store).finish(Outcome::Success, None);
        let mut disk: Value =
            serde_json::from_slice(&fs::read(directory.path().join(FILE_NAME)).unwrap()).unwrap();
        disk["entries"][0]["response"] = json!({"access_token":SECRET, "plan_type":"plus"});
        disk["entries"][0]["request"] = json!({"method":SECRET, "target":SECRET});
        fs::write(directory.path().join(FILE_NAME), disk.to_string()).unwrap();
        let mut reopened = LogStore::open(directory.path().to_owned());
        let exported = reopened.export().unwrap();
        assert!(!serde_json::to_string(&reopened.snapshot())
            .unwrap()
            .contains(SECRET));
        assert!(!fs::read_to_string(exported).unwrap().contains(SECRET));
        assert!(!fs::read_to_string(directory.path().join(FILE_NAME))
            .unwrap()
            .contains(SECRET));
    }

    #[test]
    fn bounds_and_write_failures_preserve_a_usable_memory_snapshot() {
        let (directory, store) = fixture();
        store.lock().unwrap().set_enabled(true).unwrap();
        trace(&store).finish(Outcome::Success, None);
        let mut store = store.lock().unwrap();
        let entry = store.entries[0].clone();
        store.entries = vec![entry.clone(); MAX_ENTRIES + 100];
        store.entries[0].time = 0;
        store.prune();
        assert_eq!(store.entries.len(), MAX_ENTRIES);
        let mut large = entry;
        // Valid allowlisted response repeated until the byte bound, not count bound, wins.
        large.response = json!({"dailyUsageBuckets": vec![json!({"tokens":1000000}); 250]});
        store.entries = vec![large; MAX_ENTRIES];
        store.prune();
        assert!(store.entries.len() < MAX_ENTRIES);
        assert!(store.bytes().unwrap().len() <= MAX_BYTES);
        fs::remove_file(directory.path().join(FILE_NAME)).unwrap();
        fs::create_dir(directory.path().join(FILE_NAME)).unwrap();
        store.persist();
        assert!(matches!(store.warning, Some(Warning::Write)));
        assert!(!store.snapshot().entries.is_empty());
    }

    // Synthetic loopback responses exercise the real reqwest body consumption.
    fn server(
        status: &str,
        content_type: &str,
        body: &str,
    ) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/diagnostic-test", listener.local_addr().unwrap());
        let reply = format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let task = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(reply.as_bytes());
        });
        (url, task)
    }

    #[test]
    fn http_diagnostics_preserve_business_data_and_redact_error_bodies() {
        let (_directory, store) = fixture();
        store.lock().unwrap().set_enabled(true).unwrap();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let client = reqwest::Client::builder()
                    .no_proxy()
                    .timeout(Duration::from_secs(2))
                    .build()
                    .unwrap();
                let body = json!({"access_token":SECRET, "expires_in":3600}).to_string();
                let (url, task) = server("200 OK", "application/json", &body);
                let value: Value =
                    send_with_trace(client.get(&url).bearer_auth(SECRET), trace(&store))
                        .await
                        .unwrap()
                        .json()
                        .await
                        .unwrap();
                assert_eq!(value["access_token"], SECRET); // Business flow still receives the token.
                task.join().unwrap();
                for (status, kind, body) in [
                    (
                        "403 Forbidden",
                        "text/html",
                        format!("<html>{SECRET}</html>"),
                    ),
                    (
                        "401 Unauthorized",
                        "application/json",
                        json!({"error":{"code":"invalid_grant","message":SECRET}}).to_string(),
                    ),
                    (
                        "429 Too Many Requests",
                        "application/json",
                        json!({"error":{"code":"rate_limit_exceeded"}}).to_string(),
                    ),
                ] {
                    let (url, task) = server(status, kind, &body);
                    send_with_trace(client.get(url), trace(&store))
                        .await
                        .unwrap()
                        .discard()
                        .await;
                    task.join().unwrap();
                }
                let (url, task) = server("200 OK", "text/plain", SECRET);
                assert!(send_with_trace(client.get(url), trace(&store))
                    .await
                    .unwrap()
                    .json::<Value>()
                    .await
                    .is_err());
                task.join().unwrap();
            });
        let mut store = store.lock().unwrap();
        let snapshot = store.snapshot();
        assert_eq!(snapshot.entries.len(), 5);
        assert_eq!(snapshot.entries[1].status, Some(403));
        assert!(matches!(snapshot.entries[1].body_kind, BodyKind::Html));
        assert!(matches!(
            snapshot.entries[4].outcome,
            Outcome::InvalidResponse
        ));
        assert!(!serde_json::to_string(&snapshot).unwrap().contains(SECRET));
        assert!(!String::from_utf8(store.bytes().unwrap())
            .unwrap()
            .contains(SECRET));
    }

    #[test]
    fn concurrent_query_groups_are_distinct_and_interruption_is_recorded() {
        let (_directory, store) = fixture();
        store.lock().unwrap().set_enabled(true).unwrap();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let first = scope(async {
                    let pending = trace(&store);
                    tokio::task::yield_now().await;
                    trace(&store).finish(Outcome::Success, None);
                    drop(pending);
                });
                let second = scope(async {
                    trace(&store).finish(Outcome::Connect, None);
                });
                futures_util::future::join(first, second).await;
            });
        let store = store.lock().unwrap();
        assert_eq!(store.entries.len(), 3);
        assert_ne!(store.entries[0].group, store.entries[1].group);
        assert_eq!(store.entries[1].group, store.entries[2].group);
        assert!(matches!(store.entries[2].outcome, Outcome::Interrupted));
    }
}
