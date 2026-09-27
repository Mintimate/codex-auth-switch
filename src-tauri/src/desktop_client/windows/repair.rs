//! 只修复当前用户已安装、可确认身份的 Codex Store 包的注册。
//! 安装路径只来自系统发现；不会接收 WebView 路径或访问认证缓存。

use super::{activate_package, package_identity, process_metadata, ProcessHandle};
use crate::{
    desktop_client::{run_command_with_timeout, CommandFailure, Instance, PackageIdentity},
    startup_repair::{RepairError, RepairTarget},
};
use serde::Deserialize;
use std::{
    os::windows::process::CommandExt,
    path::PathBuf,
    process::Command,
    thread,
    time::{Duration, Instant},
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

// 兼容性白名单，不是对今后产品命名的保证。更名时应核实新安装包再显式扩展。
// 该身份及可能使用 ChatGPT.exe 的清单见 OpenAI 仓库的 Windows 安装反馈：
// https://github.com/openai/codex/issues/28667
// https://github.com/openai/codex/issues/46622
const PACKAGE_NAME: &str = "OpenAI.Codex";
const PUBLISHER_ID: &str = "2p2nqsd0c76g0";
const PACKAGE_FAMILY: &str = "OpenAI.Codex_2p2nqsd0c76g0";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reply {
    status: String,
    target: Option<RepairTarget>,
}

pub(crate) fn inspect() -> Result<RepairTarget, RepairError> {
    let reply = script("inspect", None)?;
    match reply.status.as_str() {
        "ready" => reply
            .target
            .filter(valid_target)
            .ok_or(RepairError::InspectFailed),
        _ => Err(reply_error(&reply.status)),
    }
}

pub(crate) fn register(target: &RepairTarget) -> Result<(), RepairError> {
    if !valid_target(target) {
        return Err(RepairError::StaleCheck);
    }
    // 固定脚本重新发现同一包、清单及启动文件；比较完整快照后才注册。
    // 不使用 -ForceApplicationShutdown / -ForceTargetApplicationShutdown。
    let reply = script("register", Some(target))?;
    if reply.status == "registered" && reply.target.as_ref() == Some(target) {
        Ok(())
    } else if reply.status == "registered" {
        Err(RepairError::RepairUncertain)
    } else {
        Err(reply_error(&reply.status))
    }
}

/// 激活后只确认原 PID、映像和包身份持续存活，不把它说成界面或登录已经正常。
pub(crate) fn launch(target: &RepairTarget) -> Result<bool, RepairError> {
    if !valid_target(target) {
        return Err(RepairError::StaleCheck);
    }
    // 注册和启动之间发生更新、卸载或另一个实例启动时，不再启动过期目标。
    match inspect() {
        Ok(current) if current == *target => {}
        _ => return Ok(false),
    }
    let package = PackageIdentity {
        full_name: target.package_full_name.clone(),
        app_user_model_id: target.app_user_model_id.clone(),
    };
    let Ok(pid) = activate_package(&package) else {
        return Ok(false);
    };
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut observed: Option<(u64, Instant)> = None;
    while Instant::now() < deadline {
        let started = observe_process(pid, target, &package);
        match (started, observed) {
            (Some(current), Some((previous, since))) if current == previous => {
                if since.elapsed() >= Duration::from_secs(2) {
                    return Ok(true);
                }
            }
            (Some(current), _) => observed = Some((current, Instant::now())),
            (None, _) => observed = None,
        }
        thread::sleep(Duration::from_millis(200));
    }
    Ok(false)
}

fn observe_process(pid: u32, target: &RepairTarget, package: &PackageIdentity) -> Option<u64> {
    let process =
        ProcessHandle(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?);
    let (image, started) = process_metadata(process.0).ok()?;
    if !image
        .as_os_str()
        .eq_ignore_ascii_case(target.executable.as_os_str())
    {
        return None;
    }
    let instance = Instance {
        pid,
        path: image.clone(),
        executable: image,
        started: started.to_string(),
        package: None,
    };
    (package_identity(&instance).ok()?.as_ref() == Some(package)).then_some(started)
}

fn script(action: &str, target: Option<&RepairTarget>) -> Result<Reply, RepairError> {
    let registering = action == "register";
    let system_root = std::env::var_os("SystemRoot").ok_or(RepairError::InspectFailed)?;
    let mut command = Command::new(
        PathBuf::from(system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
    );
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            include_str!("repair.ps1"),
        ])
        .creation_flags(0x08000000)
        .env("CODEX_REPAIR_ACTION", action);
    if let Some(target) = target {
        command
            .env("CODEX_REPAIR_PACKAGE", &target.package_full_name)
            .env("CODEX_REPAIR_AUMID", &target.app_user_model_id)
            .env("CODEX_REPAIR_LOCATION", &target.install_location)
            .env("CODEX_REPAIR_EXECUTABLE", &target.executable)
            .env("CODEX_REPAIR_VERSION", &target.version);
    }
    // 注册助手超时并不能撤回已送交 Windows 部署服务的请求。
    let timeout = Duration::from_secs(if registering { 90 } else { 15 });
    let output = run_command_with_timeout(&mut command, timeout).map_err(|error| match error {
        CommandFailure::TimedOut if registering => RepairError::RepairUncertain,
        CommandFailure::Failed if registering => RepairError::RepairUncertain,
        _ => RepairError::InspectFailed,
    })?;
    serde_json::from_str(&output).map_err(|_| {
        if registering {
            RepairError::RepairUncertain
        } else {
            RepairError::InspectFailed
        }
    })
}

fn reply_error(status: &str) -> RepairError {
    match status {
        "notFound" => RepairError::NotFound,
        "ambiguous" => RepairError::Ambiguous,
        "running" => RepairError::Running,
        "staleCheck" => RepairError::StaleCheck,
        "repairFailed" => RepairError::RepairFailed,
        "repairUncertain" => RepairError::RepairUncertain,
        _ => RepairError::InspectFailed,
    }
}

fn valid_target(target: &RepairTarget) -> bool {
    let Some(app_id) = target
        .app_user_model_id
        .strip_prefix(&format!("{PACKAGE_FAMILY}!"))
    else {
        return false;
    };
    let version: Vec<_> = target.version.split('.').collect();
    let known_full_name = ["x64", "arm64", "x86", "neutral"].iter().any(|arch| {
        target.package_full_name
            == format!("{PACKAGE_NAME}_{}_{arch}__{PUBLISHER_ID}", target.version)
    });
    known_full_name
        && version.len() == 4
        && version.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && part.parse::<u16>().is_ok()
        })
        && !app_id.is_empty()
        && app_id.len() <= 64
        && app_id.as_bytes()[0].is_ascii_alphabetic()
        && app_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.')
        && target.install_location.is_absolute()
        && target.executable.is_absolute()
        && target.executable.starts_with(&target.install_location)
        && !target
            .executable
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
        && target.executable.file_name().is_some_and(|name| {
            name.eq_ignore_ascii_case("Codex.exe") || name.eq_ignore_ascii_case("ChatGPT.exe")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> RepairTarget {
        let full_name = "OpenAI.Codex_26.915.4065.0_x64__2p2nqsd0c76g0";
        let install_location = PathBuf::from(r"C:\Program Files\WindowsApps").join(full_name);
        RepairTarget {
            package_full_name: full_name.into(),
            app_user_model_id: format!("{PACKAGE_FAMILY}!App"),
            executable: install_location.join(r"app\ChatGPT.exe"),
            install_location,
            version: "26.915.4065.0".into(),
        }
    }

    #[test]
    fn observed_chatgpt_filename_requires_the_codex_package() {
        assert!(valid_target(&target()));
        let mut value = target();
        value.package_full_name = value.package_full_name.replace("Codex", "ChatGPT");
        assert!(!valid_target(&value));
        let mut value = target();
        value.app_user_model_id = "OpenAI.ChatGPT_2p2nqsd0c76g0!App".into();
        assert!(!valid_target(&value));
    }

    #[test]
    fn rejects_external_executables_and_unknown_entrypoints() {
        for path in [
            r"C:\Other\ChatGPT.exe",
            r"C:\Program Files\WindowsApps\..\ChatGPT.exe",
            r"app\ChatGPT.exe",
        ] {
            let mut value = target();
            value.executable = PathBuf::from(path);
            assert!(!valid_target(&value));
        }
        for app_id in ["", "App!Other", "App\0", "1App", "../App"] {
            let mut value = target();
            value.app_user_model_id = format!("{PACKAGE_FAMILY}!{app_id}");
            assert!(!valid_target(&value));
        }
    }

    #[test]
    fn rejects_version_and_publisher_changes() {
        let mut value = target();
        value.version = "26.915.4066.0".into();
        assert!(!valid_target(&value));
        let mut value = target();
        value.package_full_name = value
            .package_full_name
            .replace(PUBLISHER_ID, "otherpublisher");
        assert!(!valid_target(&value));
    }

    #[test]
    fn powershell_discovery_rejects_unsafe_packages_and_running_apps() {
        let root = tempfile::tempdir().unwrap();
        let system_root = std::env::var_os("SystemRoot").unwrap();
        let mut command = Command::new(
            PathBuf::from(system_root).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
        );
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                include_str!("repair.tests.ps1"),
            ])
            .creation_flags(0x08000000)
            .env("CODEX_REPAIR_TEST_SCRIPT", include_str!("repair.ps1"))
            .env("CODEX_REPAIR_TEST_ROOT", root.path());
        let result = run_command_with_timeout(&mut command, Duration::from_secs(30));
        assert!(matches!(result, Ok(output) if output.trim() == "passed"));
    }
}
