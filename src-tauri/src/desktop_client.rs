//! 本地桌面客户端兼容层。只请求正常退出，不结束 CLI、IDE 或任意名称匹配的进程。
//! OS 查询不读取命令行或环境变量，不把子进程输出、认证数据带进错误或进度事件。

use crate::manager::{AccountManager, AppStatus};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const DETECT_FAILED: &str = "无法安全识别 Codex 桌面客户端，请手动退出后选择仅切换";
const CLOSE_FAILED: &str = "Codex 未能正常退出，账号未切换；请结束任务并手动退出后重试";
const UNSUPPORTED: &str = "当前系统暂不支持自动重启 Codex，请选择仅切换";
const CUSTOM_HOME: &str = "自定义 CODEX_HOME 无法确认与桌面客户端一致，请选择仅切换";

#[derive(Clone, Copy, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum SwitchStage {
    Checking,
    Closing,
    Switching,
    Launching,
}

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum RestartOutcome {
    NotRequested,
    NotRunning,
    Restarted,
    LaunchFailed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResult {
    pub status: AppStatus,
    pub restart: RestartOutcome,
}

// 仅在后端使用，不把路径、PID 或其它进程信息发送到 WebView。
#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Instance {
    pid: u32,
    path: PathBuf,
    executable: PathBuf,
    started: String,
}

trait DesktopClient {
    type Target;
    fn prepare(&self) -> Result<Option<Self::Target>, String>;
    fn close(&self, target: &Self::Target) -> Result<(), String>;
    fn launch(&self, target: &Self::Target) -> Result<(), String>;
}

pub fn supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

pub fn switch_account(
    manager: &AccountManager,
    profile_id: &str,
    restart: bool,
    progress: impl Fn(SwitchStage),
) -> Result<SwitchResult, String> {
    if restart {
        ensure_default_home(manager.codex_home_path())?;
    }
    switch_with_client(manager, profile_id, restart, &SystemClient, progress)
}

fn switch_with_client<C: DesktopClient>(
    manager: &AccountManager,
    profile_id: &str,
    restart: bool,
    client: &C,
    progress: impl Fn(SwitchStage),
) -> Result<SwitchResult, String> {
    progress(SwitchStage::Checking);
    manager
        .validate_switch_target(profile_id)
        .map_err(|e| e.to_string())?;
    let target = if restart { client.prepare()? } else { None };
    if let Some(target) = &target {
        progress(SwitchStage::Closing);
        client.close(target)?;
    }
    progress(SwitchStage::Switching);
    // 退出确认后才读取最新旧账号凭据并原子提交；关闭失败不会改写认证。
    let status = manager
        .switch_account(profile_id)
        .map_err(|e| e.to_string())?;
    let restart = if let Some(target) = &target {
        progress(SwitchStage::Launching);
        if client.launch(target).is_ok() {
            RestartOutcome::Restarted
        } else {
            // 认证已经提交，不能把启动错误报告成切换失败，也不能回滚已刷新的凭据。
            RestartOutcome::LaunchFailed
        }
    } else if restart {
        RestartOutcome::NotRunning
    } else {
        RestartOutcome::NotRequested
    };
    Ok(SwitchResult { status, restart })
}

fn ensure_default_home(home: &Path) -> Result<(), String> {
    let default = dirs::home_dir().ok_or(CUSTOM_HOME)?.join(".codex");
    if fs::canonicalize(home)
        .ok()
        .zip(fs::canonicalize(default).ok())
        .is_some_and(|(actual, expected)| actual == expected)
    {
        Ok(())
    } else {
        Err(CUSTOM_HOME.into())
    }
}

struct SystemClient;

impl DesktopClient for SystemClient {
    type Target = Instance;

    fn prepare(&self) -> Result<Option<Instance>, String> {
        if !supported() {
            return Err(UNSUPPORTED.into());
        }
        let instances = detect()?;
        select_instance(instances)
    }

    fn close(&self, target: &Instance) -> Result<(), String> {
        // 再核验 PID、启动时间与路径，避免 PID 复用或用户在准备阶段更换客户端。
        let current = detect()?;
        if current.iter().any(|item| item != target) {
            return Err(DETECT_FAILED.into());
        }
        if !current.is_empty() {
            script("close", Some(target)).map_err(|_| CLOSE_FAILED.to_string())?;
        }
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            // 连同原应用包内尚未退出的子进程一起等待；不对这些进程发送终止信号。
            if detect()?.is_empty() && stopped(target)? {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(CLOSE_FAILED.into());
            }
            thread::sleep(Duration::from_millis(250));
        }
    }

    fn launch(&self, target: &Instance) -> Result<(), String> {
        if !target.executable.is_file() || !detect()?.is_empty() {
            return Err(DETECT_FAILED.into());
        }
        script("validate", Some(target))?;
        #[cfg(target_os = "macos")]
        {
            let mut command = Command::new("/usr/bin/open");
            command.arg("-a").arg(&target.path);
            run_command(&mut command)?;
        }
        #[cfg(target_os = "windows")]
        {
            let mut command = Command::new(&target.executable);
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let mut child = command.spawn().map_err(|_| DETECT_FAILED.to_string())?;
            // 不等待 GUI 生命周期；后台回收子进程句柄。
            thread::spawn(move || {
                let _ = child.wait();
            });
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if detect()?
                .iter()
                .any(|item| item.path == target.path && item.executable == target.executable)
            {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(DETECT_FAILED.into());
            }
            thread::sleep(Duration::from_millis(350));
        }
    }
}

fn select_instance(mut instances: Vec<Instance>) -> Result<Option<Instance>, String> {
    if instances.len() > 1 {
        return Err(DETECT_FAILED.into());
    }
    let instance = instances.pop();
    if let Some(item) = &instance {
        if item.pid == 0
            || item.pid == std::process::id()
            || item.started.is_empty()
            || !item.path.is_absolute()
            || !item.executable.is_absolute()
            || !item.executable.is_file()
        {
            return Err(DETECT_FAILED.into());
        }
    }
    Ok(instance)
}

fn detect() -> Result<Vec<Instance>, String> {
    serde_json::from_str(&script("detect", None)?).map_err(|_| DETECT_FAILED.into())
}

fn stopped(target: &Instance) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("/bin/ps");
        command.args(["-axo", "comm="]);
        let output = run_command(&mut command)?;
        let contents = target.path.join("Contents");
        Ok(!output
            .lines()
            .any(|line| Path::new(line.trim()).starts_with(&contents)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(script("stopped", Some(target))?.trim() == "true")
    }
}

fn script(action: &str, target: Option<&Instance>) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("/usr/bin/osascript");
        command.args([
            "-l",
            "JavaScript",
            "-e",
            include_str!("desktop_client/macos.js"),
            action,
        ]);
        if let Some(target) = target {
            command
                .arg(target.pid.to_string())
                .arg(&target.path)
                .arg(&target.executable)
                .arg(&target.started);
        }
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let system_root = std::env::var_os("SystemRoot").ok_or(DETECT_FAILED)?;
        let mut command = Command::new(
            PathBuf::from(system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            include_str!("desktop_client/windows.ps1"),
        ]);
        command.creation_flags(0x08000000);
        command.env("CODEX_SWITCH_ACTION", action);
        if let Some(target) = target {
            command
                .env("CODEX_SWITCH_PID", target.pid.to_string())
                .env("CODEX_SWITCH_PATH", &target.executable)
                .env("CODEX_SWITCH_STARTED", &target.started);
        }
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (action, target);
        Err(UNSUPPORTED.into())
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    run_command(&mut command)
}

// 输出写临时文件以避免管道堵塞，且有超时、大小限制。只会终止我们创建的查询助手。
fn run_command(command: &mut Command) -> Result<String, String> {
    let mut output = tempfile::tempfile().map_err(|_| DETECT_FAILED)?;
    command
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(output.try_clone().map_err(|_| DETECT_FAILED)?);
    let mut child = command.spawn().map_err(|_| DETECT_FAILED)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return Err(DETECT_FAILED.into()),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(DETECT_FAILED.into());
            }
        }
    }
    output.seek(SeekFrom::Start(0)).map_err(|_| DETECT_FAILED)?;
    let mut text = String::new();
    output
        .take(1024 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|_| DETECT_FAILED)?;
    if text.len() > 1024 * 1024 {
        return Err(DETECT_FAILED.into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::cell::RefCell;

    fn auth(account: &str, refresh: &str) -> Value {
        json!({"auth_mode": "chatgpt", "tokens": {
            "account_id": account, "access_token": "synthetic-access", "refresh_token": refresh
        }})
    }

    fn fixture() -> (tempfile::TempDir, AccountManager) {
        let root = tempfile::tempdir().unwrap();
        let manager = AccountManager::new(root.path().join("codex"), root.path().join("app"));
        manager.enable_file_credential_storage().unwrap();
        for id in ["target", "current"] {
            fs::write(
                manager.codex_home_path().join("auth.json"),
                serde_json::to_vec(&auth(id, "synthetic-original")).unwrap(),
            )
            .unwrap();
            manager.save_current(id).unwrap();
        }
        (root, manager)
    }

    struct FakeClient<'a> {
        manager: &'a AccountManager,
        present: bool,
        prepare_fails: bool,
        close_fails: bool,
        launch_fails: bool,
        break_write: bool,
        calls: RefCell<Vec<&'static str>>,
    }

    impl<'a> FakeClient<'a> {
        fn new(manager: &'a AccountManager) -> Self {
            Self {
                manager,
                present: true,
                prepare_fails: false,
                close_fails: false,
                launch_fails: false,
                break_write: false,
                calls: RefCell::new(vec![]),
            }
        }
    }

    impl DesktopClient for FakeClient<'_> {
        type Target = ();
        fn prepare(&self) -> Result<Option<()>, String> {
            self.calls.borrow_mut().push("prepare");
            if self.prepare_fails {
                return Err(DETECT_FAILED.into());
            }
            Ok(self.present.then_some(()))
        }
        fn close(&self, _: &()) -> Result<(), String> {
            self.calls.borrow_mut().push("close");
            assert_eq!(
                self.manager.status().unwrap().active_account_id.as_deref(),
                Some("current")
            );
            if self.close_fails {
                return Err(CLOSE_FAILED.into());
            }
            let path = self.manager.codex_home_path().join("auth.json");
            // 模拟桌面客户端在正常退出时保存刚刷新过的凭据。
            fs::write(
                &path,
                serde_json::to_vec(&auth("current", "synthetic-rotated")).unwrap(),
            )
            .unwrap();
            if self.break_write {
                fs::remove_file(&path).unwrap();
                fs::create_dir(&path).unwrap();
            }
            Ok(())
        }
        fn launch(&self, _: &()) -> Result<(), String> {
            self.calls.borrow_mut().push("launch");
            assert_eq!(
                self.manager.status().unwrap().active_account_id.as_deref(),
                Some("target")
            );
            if self.launch_fails {
                Err(DETECT_FAILED.into())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn restart_waits_for_quit_and_preserves_exit_time_token_rotation() {
        let (_root, manager) = fixture();
        let client = FakeClient::new(&manager);
        let stages = RefCell::new(vec![]);
        let result = switch_with_client(&manager, "target", true, &client, |stage| {
            stages.borrow_mut().push(stage)
        })
        .unwrap();
        assert_eq!(result.restart, RestartOutcome::Restarted);
        assert_eq!(*client.calls.borrow(), ["prepare", "close", "launch"]);
        assert_eq!(
            *stages.borrow(),
            [
                SwitchStage::Checking,
                SwitchStage::Closing,
                SwitchStage::Switching,
                SwitchStage::Launching
            ]
        );
        manager.switch_account("current").unwrap();
        let saved: Value =
            serde_json::from_slice(&fs::read(manager.codex_home_path().join("auth.json")).unwrap())
                .unwrap();
        assert!(saved["tokens"]["refresh_token"] == "synthetic-rotated");
    }

    #[test]
    fn only_switch_never_inspects_or_controls_processes() {
        let (_root, manager) = fixture();
        let client = FakeClient::new(&manager);
        let result = switch_with_client(&manager, "target", false, &client, |_| {}).unwrap();
        assert_eq!(result.restart, RestartOutcome::NotRequested);
        assert!(client.calls.borrow().is_empty());
    }

    #[test]
    fn closed_client_stays_closed() {
        let (_root, manager) = fixture();
        let mut client = FakeClient::new(&manager);
        client.present = false;
        let result = switch_with_client(&manager, "target", true, &client, |_| {}).unwrap();
        assert_eq!(result.restart, RestartOutcome::NotRunning);
        assert_eq!(*client.calls.borrow(), ["prepare"]);
        assert_eq!(result.status.active_account_id.as_deref(), Some("target"));
    }

    #[test]
    fn invalid_target_does_not_touch_client_or_auth() {
        let (_root, manager) = fixture();
        let client = FakeClient::new(&manager);
        assert!(switch_with_client(&manager, "missing", true, &client, |_| {}).is_err());
        assert!(client.calls.borrow().is_empty());
        assert_eq!(
            manager.status().unwrap().active_account_id.as_deref(),
            Some("current")
        );
    }

    #[test]
    fn detection_and_quit_failures_leave_both_auth_and_vault_unchanged() {
        for detection in [true, false] {
            let (_root, manager) = fixture();
            let auth_path = manager.codex_home_path().join("auth.json");
            let before_auth = fs::read(&auth_path).unwrap();
            let before_vault = fs::read(manager.vault_path()).unwrap();
            let mut client = FakeClient::new(&manager);
            client.prepare_fails = detection;
            client.close_fails = !detection;
            assert!(switch_with_client(&manager, "target", true, &client, |_| {}).is_err());
            assert!(fs::read(auth_path).unwrap() == before_auth);
            assert!(fs::read(manager.vault_path()).unwrap() == before_vault);
            assert!(!client.calls.borrow().contains(&"launch"));
        }
    }

    #[test]
    fn auth_write_failure_does_not_launch_target() {
        let (_root, manager) = fixture();
        let mut client = FakeClient::new(&manager);
        client.break_write = true;
        assert!(switch_with_client(&manager, "target", true, &client, |_| {}).is_err());
        assert_eq!(*client.calls.borrow(), ["prepare", "close"]);
    }

    #[test]
    fn launch_failure_reports_committed_switch_without_rollback() {
        let (_root, manager) = fixture();
        let mut client = FakeClient::new(&manager);
        client.launch_fails = true;
        let result = switch_with_client(&manager, "target", true, &client, |_| {}).unwrap();
        assert_eq!(result.restart, RestartOutcome::LaunchFailed);
        assert_eq!(result.status.active_account_id.as_deref(), Some("target"));
        // 仅允许账号摘要和重启结果跨过 IPC 边界。
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("synthetic-"));
        assert!(!serialized.contains("access_token"));
        assert!(!serialized.contains("refresh_token"));
    }

    #[test]
    fn custom_home_is_rejected_before_any_process_control() {
        let (_root, manager) = fixture();
        assert_eq!(
            ensure_default_home(manager.codex_home_path()).unwrap_err(),
            CUSTOM_HOME
        );
    }

    #[test]
    fn ambiguous_or_invalid_instances_are_never_selected() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let instance = Instance {
            pid: 42,
            path: file.path().into(),
            executable: file.path().into(),
            started: "1".into(),
        };
        assert!(select_instance(vec![instance.clone(), instance.clone()]).is_err());
        let mut invalid = instance.clone();
        invalid.pid = std::process::id();
        assert!(select_instance(vec![invalid]).is_err());
        let mut invalid = instance;
        invalid.executable = PathBuf::from("codex");
        assert!(select_instance(vec![invalid]).is_err());
        assert!(select_instance(vec![]).unwrap().is_none());
    }

    #[test]
    #[cfg(unix)]
    fn command_failure_never_includes_child_output() {
        let error = run_command(Command::new("/bin/sh").args([
            "-c",
            "echo SYNTHETIC_SECRET; echo SYNTHETIC_SECRET >&2; exit 1",
        ]))
        .unwrap_err();
        assert_eq!(error, DETECT_FAILED);
    }
}
