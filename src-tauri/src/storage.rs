//! 本机文件的安全原子写入，与账号和额度业务无关。
use std::{fs, io::Write, path::Path};

// 兼容旧版 Windows 两步替换中断后留下的备份。目标存在时不覆盖、不删除备份。
#[cfg(windows)]
pub(crate) fn recover_legacy_backup(path: &Path) -> Result<(), String> {
    let backup = path.with_extension("cam-backup");
    if !path.exists() && backup.is_file() {
        fs::rename(&backup, path).map_err(|error| format!("恢复旧认证备份失败: {error}"))?;
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn recover_legacy_backup(_path: &Path) -> Result<(), String> {
    Ok(())
}

pub(crate) fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), String> {
    recover_legacy_backup(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("无法定位 {} 的父目录", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建目录 {} 失败: {error}", parent.display()))?;
    secure_directory(parent)?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("credentials");
    let mut temporary = tempfile::Builder::new()
        .prefix(&format!(".{file_name}.cam-"))
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|error| format!("创建临时文件失败: {error}"))?;
    temporary
        .write_all(contents)
        .map_err(|error| format!("写入临时文件失败: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("同步临时文件失败: {error}"))?;
    // tempfile 在 Windows 使用 MoveFileExW(REPLACE_EXISTING)，不会先移走目标文件。
    temporary
        .persist(path)
        .map_err(|error| format!("原子替换 {} 失败: {}", path.display(), error.error))?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("同步目录失败: {error}"))?;
    Ok(())
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("设置目录 {} 权限失败: {error}", path.display()))
}

#[cfg(not(unix))]
fn secure_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}
