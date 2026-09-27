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

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub(crate) use windows::repair as startup_repair_backend;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopState {
    Running,
    NotRunning,
    Unsupported,
    Unavailable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchVerification {
    pub credential_file: crate::manager::CredentialFileState,
    pub desktop: DesktopState,
    pub checked_at: u64,
}

pub fn verify_switch(manager: &AccountManager, profile_id: &str) -> SwitchVerification {
    let desktop = if !supported() {
        DesktopState::Unsupported
    } else if ensure_default_home(manager.codex_home_path()).is_err() {
        DesktopState::Unavailable
    } else {
        match SystemClient.prepare() {
            Ok(Some(_)) => DesktopState::Running,
            Ok(None) => DesktopState::NotRunning,
            Err(_) => DesktopState::Unavailable,
        }
    };
    SwitchVerification {
        credential_file: manager.verify_credential_file(profile_id),
        desktop,
        checked_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    }
}

// 仅在后端使用，不把路径、PID 或其它进程信息发送到 WebView。
#[derive(Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Instance {
    pid: u32,
    path: PathBuf,
    executable: PathBuf,
    started: String,
    // Windows 原生查询结果，只在后端内存中使用，不经脚本或 WebView 传递。
    #[serde(skip)]
    package: Option<PackageIdentity>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PackageIdentity {
    full_name: String,
    app_user_model_id: String,
}

#[cfg(any(target_os = "windows", test))]
enum WindowsLaunchTarget<'a> {
    Executable,
    Packaged(&'a PackageIdentity),
}

#[cfg(any(target_os = "windows", test))]
fn windows_launch_target(target: &Instance) -> Result<WindowsLaunchTarget<'_>, String> {
    if let Some(package) = &target.package {
        if package.full_name.is_empty()
            || package.app_user_model_id.is_empty()
            || package.full_name.contains('\0')
            || package.app_user_model_id.contains('\0')
        {
            return Err(DETECT_FAILED.into());
        }
        return Ok(WindowsLaunchTarget::Packaged(package));
    }
    // 旧版工具可能已经裸启动了包内 EXE。即使该进程确实没有包身份，
    // WindowsApps 或包清单仍说明不能把它作为普通安装版再次启动。
    if target
        .executable
        .components()
        .any(|part| part.as_os_str().eq_ignore_ascii_case("WindowsApps"))
    {
        return Err(DETECT_FAILED.into());
    }
    for directory in target.executable.ancestors().skip(1) {
        if directory
            .join("AppxManifest.xml")
            .try_exists()
            .map_err(|_| DETECT_FAILED)?
        {
            return Err(DETECT_FAILED.into());
        }
    }
    Ok(WindowsLaunchTarget::Executable)
}

// Windows 需要确认新 PID、原应用和包身份，并观察同一进程持续存在。
// 这只确认进程启动，不把进程存在当作界面或登录状态已经就绪。
struct LaunchConfirmation {
    expected_pid: Option<u32>,
    stable_for: Duration,
    observed: Option<(Instance, Duration)>,
}

impl LaunchConfirmation {
    fn observe(&mut self, target: &Instance, instances: &[Instance], elapsed: Duration) -> bool {
        let [current] = instances else {
            self.observed = None;
            return false;
        };
        if current.path != target.path
            || current.executable != target.executable
            || current.package != target.package
            || self.expected_pid.is_some_and(|pid| current.pid != pid)
            || (current.pid == target.pid && current.started == target.started)
        {
            self.observed = None;
            return false;
        }
        let since = match &self.observed {
            Some((previous, since)) if previous == current => *since,
            _ => {
                self.observed = Some((current.clone(), elapsed));
                elapsed
            }
        };
        elapsed.saturating_sub(since) >= self.stable_for
    }
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
        let target = select_instance(instances)?;
        if let Some(target) = &target {
            // 退出前就确认启动入口；拒绝识别不完整的包应用，避免关掉后才发现无法启动。
            script("validate", Some(target))?;
            #[cfg(target_os = "windows")]
            if let WindowsLaunchTarget::Packaged(package) = windows_launch_target(target)? {
                windows::validate_package(package)?;
            }
        }
        Ok(target)
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
            // 退出中的进程可能在脚本快照与原生身份查询之间消失。
            // 查询失败只表示尚未确认退出，继续等待，不能据此写入凭据。
            if matches!(detect(), Ok(instances) if instances.is_empty())
                && stopped(target).unwrap_or(false)
            {
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
        #[cfg(not(target_os = "windows"))]
        let expected_pid = None;
        #[cfg(target_os = "macos")]
        {
            let mut command = Command::new("/usr/bin/open");
            command.arg("-a").arg(&target.path);
            run_command(&mut command)?;
        }
        #[cfg(target_os = "windows")]
        let expected_pid = Some(match windows_launch_target(target)? {
            WindowsLaunchTarget::Packaged(package) => windows::activate_package(package)?,
            WindowsLaunchTarget::Executable => {
                let mut command = Command::new(&target.executable);
                command
                    .current_dir(target.executable.parent().ok_or(DETECT_FAILED)?)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                let mut child = command.spawn().map_err(|_| DETECT_FAILED.to_string())?;
                let pid = child.id();
                // 不等待 GUI 生命周期；后台回收子进程句柄。
                thread::spawn(move || {
                    let _ = child.wait();
                });
                pid
            }
        });
        let mut confirmation = LaunchConfirmation {
            expected_pid,
            stable_for: if cfg!(target_os = "windows") {
                Duration::from_secs(2)
            } else {
                Duration::ZERO
            },
            observed: None,
        };
        let launched_at = Instant::now();
        let deadline = launched_at + Duration::from_secs(15);
        loop {
            // 瞬态查询失败和进程消失都重置观察时间，超时前允许重新确认。
            let instances = detect().unwrap_or_default();
            if confirmation.observe(target, &instances, launched_at.elapsed()) {
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
    let instances: Vec<Instance> =
        serde_json::from_str(&script("detect", None)?).map_err(|_| DETECT_FAILED)?;
    #[cfg(target_os = "windows")]
    let instances = instances
        .into_iter()
        .map(|mut instance| {
            instance.package = windows::package_identity(&instance)?;
            Ok(instance)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(instances)
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
    run_command_with_timeout(command, Duration::from_secs(5)).map_err(|_| DETECT_FAILED.into())
}

#[derive(Debug, PartialEq, Eq)]
enum CommandFailure {
    Failed,
    TimedOut,
}

fn run_command_with_timeout(
    command: &mut Command,
    timeout: Duration,
) -> Result<String, CommandFailure> {
    let mut output = tempfile::tempfile().map_err(|_| CommandFailure::Failed)?;
    command
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(output.try_clone().map_err(|_| CommandFailure::Failed)?);
    let mut child = command.spawn().map_err(|_| CommandFailure::Failed)?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return Err(CommandFailure::Failed),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            state => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(if state.is_ok() {
                    CommandFailure::TimedOut
                } else {
                    CommandFailure::Failed
                });
            }
        }
    }
    output
        .seek(SeekFrom::Start(0))
        .map_err(|_| CommandFailure::Failed)?;
    let mut text = String::new();
    output
        .take(1024 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|_| CommandFailure::Failed)?;
    if text.len() > 1024 * 1024 {
        return Err(CommandFailure::Failed);
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
            package: None,
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

    fn desktop_instance(executable: &Path) -> Instance {
        Instance {
            pid: 42,
            path: executable.into(),
            executable: executable.into(),
            started: "1".into(),
            package: None,
        }
    }

    fn package_identity() -> PackageIdentity {
        PackageIdentity {
            full_name: "Example.Codex_1.0.0.0_x64__publisher".into(),
            app_user_model_id: "Example.Codex_publisher!Codex".into(),
        }
    }

    #[test]
    fn windows_launch_selects_the_observed_package_instead_of_its_executable() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let mut target = desktop_instance(file.path());
        assert!(matches!(
            windows_launch_target(&target).unwrap(),
            WindowsLaunchTarget::Executable
        ));
        target.package = Some(package_identity());
        let WindowsLaunchTarget::Packaged(package) = windows_launch_target(&target).unwrap() else {
            panic!("packaged applications must use activation");
        };
        assert_eq!(package, target.package.as_ref().unwrap());
        target.package.as_mut().unwrap().app_user_model_id.clear();
        assert!(windows_launch_target(&target).is_err());
        target.package = Some(package_identity());
        target.package.as_mut().unwrap().full_name.push('\0');
        assert!(windows_launch_target(&target).is_err());
    }

    #[test]
    fn package_files_without_process_identity_never_fall_back_to_exe_launch() {
        let root = tempfile::tempdir().unwrap();
        for directory in ["WindowsApps", "windowsapps"] {
            let executable = root.path().join(directory).join("Codex.exe");
            assert!(windows_launch_target(&desktop_instance(&executable)).is_err());
        }
        // 解压包、侧载包可以位于 WindowsApps 以外；包清单同样拒绝降级。
        let package_root = root.path().join("sideloaded");
        fs::create_dir_all(package_root.join("app")).unwrap();
        fs::write(package_root.join("AppxManifest.xml"), "<Package />").unwrap();
        let executable = package_root.join("app/Codex.exe");
        assert!(windows_launch_target(&desktop_instance(&executable)).is_err());
        let mut packaged = desktop_instance(&executable);
        packaged.package = Some(package_identity());
        assert!(matches!(
            windows_launch_target(&packaged).unwrap(),
            WindowsLaunchTarget::Packaged(_)
        ));
    }

    #[test]
    fn script_output_cannot_supply_native_package_identity() {
        let instance: Instance = serde_json::from_value(json!({
            "pid": 42, "path": "/Codex.exe", "executable": "/Codex.exe", "started": "1",
            "package": {"full_name": "injected", "app_user_model_id": "injected"}
        }))
        .unwrap();
        assert!(instance.package.is_none());
    }

    fn launch_confirmation() -> LaunchConfirmation {
        LaunchConfirmation {
            expected_pid: Some(43),
            stable_for: Duration::from_secs(2),
            observed: None,
        }
    }

    #[test]
    fn restart_requires_the_activated_pid_and_original_package_identity() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let mut target = desktop_instance(file.path());
        target.package = Some(package_identity());
        let mut current = target.clone();
        current.pid = 43;
        current.started = "2".into();
        let mut confirmation = launch_confirmation();
        assert!(!confirmation.observe(&target, &[current.clone()], Duration::ZERO));
        assert!(confirmation.observe(&target, &[current.clone()], Duration::from_secs(2)));

        let mut wrong_package = current.clone();
        wrong_package.package.as_mut().unwrap().full_name = "AnotherPackage".into();
        let mut wrong_app = current.clone();
        wrong_app.package.as_mut().unwrap().app_user_model_id = "Other!App".into();
        let mut missing_identity = current.clone();
        missing_identity.package = None;
        let mut wrong_pid = current.clone();
        wrong_pid.pid = 44;
        let mut wrong_path = current.clone();
        wrong_path.executable = file.path().with_extension("other");
        for instance in [
            wrong_package,
            wrong_app,
            missing_identity,
            wrong_pid,
            wrong_path,
        ] {
            let mut confirmation = launch_confirmation();
            assert!(!confirmation.observe(&target, &[instance.clone()], Duration::ZERO));
            assert!(!confirmation.observe(&target, &[instance], Duration::from_secs(3)));
        }
        assert!(!confirmation.observe(
            &target,
            &[current.clone(), current],
            Duration::from_secs(3)
        ));
    }

    #[test]
    fn a_disappearing_or_replaced_process_restarts_the_observation_window() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let target = desktop_instance(file.path());
        let mut current = target.clone();
        current.pid = 43;
        current.started = "2".into();
        let mut confirmation = launch_confirmation();
        assert!(!confirmation.observe(&target, &[current.clone()], Duration::ZERO));
        assert!(!confirmation.observe(&target, &[], Duration::from_secs(1)));
        assert!(!confirmation.observe(&target, &[current.clone()], Duration::from_secs(2)));
        // 同 PID 被复用也不能沿用前一个进程的观察时间。
        current.started = "3".into();
        assert!(!confirmation.observe(&target, &[current.clone()], Duration::from_secs(3)));
        assert!(confirmation.observe(&target, &[current], Duration::from_secs(5)));
        confirmation.expected_pid = None;
        assert!(!confirmation.observe(&target, &[target.clone()], Duration::from_secs(6)));
    }

    #[test]
    #[cfg(unix)]
    fn helper_timeout_is_distinct_from_a_completed_failure() {
        assert_eq!(
            run_command_with_timeout(
                Command::new("/bin/sh").args(["-c", "exec sleep 1"]),
                Duration::from_millis(50),
            ),
            Err(CommandFailure::TimedOut)
        );
        assert_eq!(
            run_command_with_timeout(
                Command::new("/bin/sh").args(["-c", "exit 1"]),
                Duration::from_secs(1),
            ),
            Err(CommandFailure::Failed)
        );
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
