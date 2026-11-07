//! macOS 退出确认的纯路径兼容层，不读取进程参数，也不终止任何进程。

use std::path::{Component, Path};

/// `executable_paths` 仅为 `ps -axo comm=` 的输出，不包含命令行参数。
pub(super) fn bundle_processes_stopped(bundle_path: &Path, executable_paths: &str) -> bool {
    let contents = bundle_path.join("Contents");
    !executable_paths.lines().any(|line| {
        let executable = Path::new(line.trim());
        let Ok(relative) = executable.strip_prefix(&contents) else {
            return false;
        };
        // 主程序退出后，崩溃报告进程可能成为孤儿并长期存活。
        // 仅放行核验过的完整框架路径，其他后台进程仍必须退出。
        !known_crash_reporter(relative)
    })
}

fn known_crash_reporter(relative: &Path) -> bool {
    let Ok(helper) = relative.strip_prefix("Frameworks/Codex Framework.framework/Versions") else {
        return false;
    };
    let mut components = helper.components();
    let Some(Component::Normal(version)) = components.next() else {
        return false;
    };
    // 本机已核验的 Codex Framework 使用四段 Chromium 版本号。
    // 不推测其它框架、别名目录或未来未知布局里的同名程序身份。
    let Some(version) = version.to_str() else {
        return false;
    };
    let parts: Vec<_> = version.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()))
        && matches!(components.next(), Some(Component::Normal(name)) if name == "Helpers")
        && matches!(components.next(), Some(Component::Normal(name)) if name == "browser_crashpad_handler")
        && components.next().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLE: &str = "/Applications/Codex.app";
    const CRASHPAD: &str = "Contents/Frameworks/Codex Framework.framework/Versions/157.0.8103.39/Helpers/browser_crashpad_handler";

    fn executable(relative: &str) -> String {
        format!("{BUNDLE}/{relative}")
    }

    #[test]
    fn orphaned_crash_reporters_and_unrelated_cli_do_not_block_exit() {
        let output = format!(
            "  {}\n{}\n/usr/local/bin/codex\n/Applications/Other.app/Contents/MacOS/Other\n",
            executable(CRASHPAD),
            executable("Contents/Frameworks/Codex Framework.framework/Versions/158.0.8200.1/Helpers/browser_crashpad_handler")
        );
        assert!(bundle_processes_stopped(Path::new(BUNDLE), &output));
        assert!(bundle_processes_stopped(Path::new(BUNDLE), "\n  \n"));
    }

    #[test]
    fn application_workers_and_updaters_still_block_exit() {
        for relative in [
            "Contents/MacOS/Codex",
            "Contents/MacOS/ChatGPT",
            "Contents/Frameworks/Codex Framework.framework/Versions/157.0.8103.39/Helpers/Codex (Aperitif Renderer).app/Contents/MacOS/Codex (Aperitif Renderer)",
            "Contents/Frameworks/Codex Helper (Renderer).app/Contents/MacOS/Codex Helper (Renderer)",
            "Contents/Frameworks/Codex Helper (GPU).app/Contents/MacOS/Codex Helper (GPU)",
            "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
            "Contents/Resources/codex",
            "Contents/Resources/cua_node/bin/node",
            "Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app/Contents/MacOS/Updater",
            "Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt",
        ] {
            let output = format!("{}\n{}\n", executable(CRASHPAD), executable(relative));
            assert!(!bundle_processes_stopped(Path::new(BUNDLE), &output), "{relative}");
        }
    }

    #[test]
    fn unknown_paths_and_same_named_executables_are_not_exempted() {
        for relative in [
            "Contents/Resources/browser_crashpad_handler",
            "Contents/Frameworks/Other.framework/Versions/157.0.8103.39/Helpers/browser_crashpad_handler",
            "Contents/Frameworks/Codex Framework.framework/Versions/157.0.8103.39/Resources/browser_crashpad_handler",
            "Contents/Frameworks/Codex Framework.framework/Versions/157.0.8103.39/Helpers/browser_crashpad_handler-extra",
            "Contents/Frameworks/Codex Framework.framework/Versions/157.0.8103.39/Helpers/browser_crashpad_handler/worker",
            "Contents/Frameworks/Codex Framework.framework/Versions/157.0.8103.39/Helpers/extra/browser_crashpad_handler",
            "Contents/Frameworks/Codex Framework.framework/Versions/../Helpers/browser_crashpad_handler",
            "Contents/Frameworks/Codex Framework.framework/Versions/Current/Helpers/browser_crashpad_handler",
            "Contents/Frameworks/Codex Framework.framework/Versions/157.0.8103.39/Helpers/chrome_crashpad_handler",
            "Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler",
            "Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler",
        ] {
            assert!(!bundle_processes_stopped(Path::new(BUNDLE), &executable(relative)), "{relative}");
        }
    }

    #[test]
    fn bundle_prefix_collisions_and_spaces_use_path_component_boundaries() {
        let unrelated = "/Applications/Codex.app.backup/Contents/MacOS/Codex\n/Applications/Codex.app/Contents-extra/worker\n";
        assert!(bundle_processes_stopped(Path::new(BUNDLE), unrelated));
        let bundle = Path::new("/Users/example/Local Apps/Codex.app");
        let crashpad = format!("{}/{}\n", bundle.display(), CRASHPAD);
        assert!(bundle_processes_stopped(bundle, &crashpad));
        let running = format!("{crashpad}{}/Contents/MacOS/Codex\n", bundle.display());
        assert!(!bundle_processes_stopped(bundle, &running));
    }
}
