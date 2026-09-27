//! Windows 包身份与启动兼容层；不读取进程命令行、环境变量或认证缓存。
//! 只把系统明确返回的「无包身份」视作普通应用，其余查询错误均停止自动重启。

use super::{Instance, PackageIdentity, DETECT_FAILED};
use std::{ffi::OsString, mem::size_of, os::windows::ffi::OsStringExt, path::PathBuf};
use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::{
            CloseHandle, APPMODEL_ERROR_NO_PACKAGE, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS,
            FILETIME, HANDLE, RPC_E_CHANGED_MODE, WIN32_ERROR,
        },
        Storage::Packaging::Appx::{
            ClosePackageInfo, GetApplicationUserModelId, GetPackageApplicationIds,
            GetPackageFullName, OpenPackageInfoByFullName, _PACKAGE_INFO_REFERENCE,
        },
        System::{
            Com::{
                CoAllowSetForegroundWindow, CoCreateInstance, CoInitializeEx, CoUninitialize,
                CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED,
            },
            Threading::{
                GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::Shell::{ApplicationActivationManager, IApplicationActivationManager, AO_NOERRORUI},
    },
};

const MAX_STRING_CHARS: usize = 32_768;
const MAX_PACKAGE_INFO_BYTES: usize = 1024 * 1024;
// FILETIME 从 1601 年起计时，PowerShell DateTime.Ticks 从公元 1 年起计时。
const FILETIME_TO_DATETIME_TICKS: u64 = 504_911_232_000_000_000;

fn failed() -> String {
    DETECT_FAILED.to_string()
}

struct ProcessHandle(HANDLE);

impl Drop for ProcessHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct PackageInfo(*mut _PACKAGE_INFO_REFERENCE);

impl Drop for PackageInfo {
    fn drop(&mut self) {
        unsafe {
            let _ = ClosePackageInfo(self.0);
        }
    }
}

// 仅配平本次成功的 CoInitializeEx；已有其它 apartment 时沿用它，不擅自反初始化。
struct ComApartment(bool);

impl ComApartment {
    fn initialize() -> Result<Self, String> {
        let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        if result.is_ok() {
            Ok(Self(true))
        } else if result == RPC_E_CHANGED_MODE {
            Ok(Self(false))
        } else {
            Err(failed())
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

/// 从同一进程句柄读取映像、创建时间和身份，防止 PowerShell 查询之后 PID 被复用。
/// https://learn.microsoft.com/windows/win32/api/appmodel/nf-appmodel-getpackagefullname
/// https://learn.microsoft.com/windows/win32/api/appmodel/nf-appmodel-getapplicationusermodelid
pub(super) fn package_identity(instance: &Instance) -> Result<Option<PackageIdentity>, String> {
    let process = ProcessHandle(
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, instance.pid) }
            .map_err(|_| failed())?,
    );
    let (image, started) = process_metadata(process.0)?;
    if image != instance.executable || started.to_string() != instance.started {
        return Err(failed());
    }

    let full_name = query_string(
        |length, buffer| unsafe { GetPackageFullName(process.0, length, buffer) },
        Some(APPMODEL_ERROR_NO_PACKAGE),
    )?;
    let Some(full_name) = full_name else {
        return Ok(None);
    };
    // 已有包身份却无法取得应用身份时，不能冒险把它当作普通 EXE。
    let app_user_model_id = query_string(
        |length, buffer| unsafe { GetApplicationUserModelId(process.0, length, buffer) },
        None,
    )?
    .ok_or_else(failed)?;
    Ok(Some(PackageIdentity {
        full_name,
        app_user_model_id,
    }))
}

fn process_metadata(process: HANDLE) -> Result<(PathBuf, u64), String> {
    let mut image = vec![0u16; MAX_STRING_CHARS];
    let mut length = image.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(image.as_mut_ptr()),
            &mut length,
        )
    }
    .map_err(|_| failed())?;
    if length == 0 || length as usize > image.len() {
        return Err(failed());
    }
    let image = PathBuf::from(OsString::from_wide(&image[..length as usize]));
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) }
        .map_err(|_| failed())?;
    let filetime = (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime);
    let ticks = filetime
        .checked_add(FILETIME_TO_DATETIME_TICKS)
        .ok_or_else(failed)?;
    Ok((image, ticks))
}

fn query_string(
    mut query: impl FnMut(*mut u32, Option<PWSTR>) -> WIN32_ERROR,
    absent: Option<WIN32_ERROR>,
) -> Result<Option<String>, String> {
    let mut length = 0u32;
    let result = query(&mut length, None);
    if absent == Some(result) {
        return Ok(None);
    }
    if result != ERROR_INSUFFICIENT_BUFFER || !(2..=MAX_STRING_CHARS as u32).contains(&length) {
        return Err(failed());
    }
    let mut buffer = vec![0u16; length as usize];
    if query(&mut length, Some(PWSTR(buffer.as_mut_ptr()))) != ERROR_SUCCESS
        || !(2..=buffer.len() as u32).contains(&length)
        || buffer[length as usize - 1] != 0
    {
        return Err(failed());
    }
    let value = &buffer[..length as usize - 1];
    if value.contains(&0) {
        return Err(failed());
    }
    String::from_utf16(value).map(Some).map_err(|_| failed())
}

fn wide_string(value: &str) -> Result<Vec<u16>, String> {
    if value.is_empty() || value.contains('\0') {
        return Err(failed());
    }
    let mut wide: Vec<u16> = value.encode_utf16().collect();
    if wide.len() >= MAX_STRING_CHARS {
        return Err(failed());
    }
    wide.push(0);
    Ok(wide)
}

/// 关闭应用前确认当前用户仍安装此包、AUMID 仍属于此包，并确认激活服务可用。
pub(super) fn validate_package(package: &PackageIdentity) -> Result<(), String> {
    validate_registered_package(package)?;
    let _apartment = ComApartment::initialize()?;
    let _manager = activation_manager()?;
    Ok(())
}

fn validate_registered_package(package: &PackageIdentity) -> Result<(), String> {
    let full_name = wide_string(&package.full_name)?;
    wide_string(&package.app_user_model_id)?;
    let mut reference = std::ptr::null_mut();
    // ERROR_NOT_FOUND 明确表示该包未为当前用户安装，不能改用其它版本或裸 EXE。
    // https://learn.microsoft.com/windows/win32/api/appmodel/nf-appmodel-openpackageinfobyfullname
    if unsafe { OpenPackageInfoByFullName(PCWSTR(full_name.as_ptr()), None, &mut reference) }
        != ERROR_SUCCESS
        || reference.is_null()
    {
        return Err(failed());
    }
    let info = PackageInfo(reference);
    let mut length = 0u32;
    // https://learn.microsoft.com/windows/win32/api/appmodel/nf-appmodel-getpackageapplicationids
    if unsafe { GetPackageApplicationIds(info.0, &mut length, None, None) }
        != ERROR_INSUFFICIENT_BUFFER
        || length == 0
        || length as usize > MAX_PACKAGE_INFO_BYTES
    {
        return Err(failed());
    }
    // API 返回指针表及 UTF-16 字符串，不能使用只有字节对齐保证的 Vec<u8>。
    let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    let capacity = length;
    let mut count = 0u32;
    if unsafe {
        GetPackageApplicationIds(
            info.0,
            &mut length,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut count),
        )
    } != ERROR_SUCCESS
        || length > capacity
        || !application_ids_contain(
            &buffer,
            length as usize,
            count as usize,
            &package.app_user_model_id,
        )?
    {
        return Err(failed());
    }
    Ok(())
}

fn application_ids_contain(
    buffer: &[usize],
    byte_length: usize,
    count: usize,
    expected: &str,
) -> Result<bool, String> {
    let table_bytes = count.checked_mul(size_of::<usize>()).ok_or_else(failed)?;
    if byte_length > std::mem::size_of_val(buffer) || table_bytes > byte_length {
        return Err(failed());
    }
    let base = buffer.as_ptr().cast::<u8>();
    let base_address = base as usize;
    let mut found = false;
    for pointer in &buffer[..count] {
        let offset = pointer.checked_sub(base_address).ok_or_else(failed)?;
        if offset < table_bytes || offset >= byte_length || offset % size_of::<u16>() != 0 {
            return Err(failed());
        }
        // 只读取 API 缓冲区内的字符串，任何无效指针、越界或缺少终止符均拒绝。
        let text = unsafe {
            std::slice::from_raw_parts(
                base.add(offset).cast::<u16>(),
                (byte_length - offset) / size_of::<u16>(),
            )
        };
        let end = text
            .iter()
            .position(|character| *character == 0)
            .ok_or_else(failed)?;
        let app_id = String::from_utf16(&text[..end]).map_err(|_| failed())?;
        found |= app_id == expected;
    }
    Ok(found)
}

fn activation_manager() -> Result<IApplicationActivationManager, String> {
    // 在进程外创建，确保本次调用结束后激活参数仍有完整生命周期。
    // https://learn.microsoft.com/windows/win32/api/shobjidl_core/nn-shobjidl_core-iapplicationactivationmanager
    unsafe { CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER) }
        .map_err(|_| failed())
}

/// 只通过已校验的 AUMID 激活；返回值由调用方进一步核验进程与包身份。
/// https://learn.microsoft.com/windows/win32/api/shobjidl_core/nf-shobjidl_core-iapplicationactivationmanager-activateapplication
pub(super) fn activate_package(package: &PackageIdentity) -> Result<u32, String> {
    validate_registered_package(package)?;
    let app_id = wide_string(&package.app_user_model_id)?;
    let _apartment = ComApartment::initialize()?;
    let manager = activation_manager()?;
    // 前台权限受当前系统焦点规则约束，授权失败不应阻止正常后台启动。
    let _ = unsafe { CoAllowSetForegroundWindow(&manager, None) };
    let pid = unsafe {
        manager.ActivateApplication(PCWSTR(app_id.as_ptr()), PCWSTR::null(), AO_NOERRORUI)
    }
    .map_err(|_| failed())?;
    if pid == 0 {
        return Err(failed());
    }
    Ok(pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::windows::Win32::Foundation::{
        APPMODEL_ERROR_NO_APPLICATION, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER,
    };

    #[test]
    fn only_explicit_no_package_can_select_an_unpacked_application() {
        assert_eq!(
            query_string(
                |_, _| APPMODEL_ERROR_NO_PACKAGE,
                Some(APPMODEL_ERROR_NO_PACKAGE)
            ),
            Ok(None)
        );
        // 访问失败、缺少应用身份、一般错误均不能伪装成普通安装版。
        for error in [
            ERROR_ACCESS_DENIED,
            APPMODEL_ERROR_NO_APPLICATION,
            ERROR_INVALID_PARAMETER,
        ] {
            assert_eq!(
                query_string(|_, _| error, Some(APPMODEL_ERROR_NO_PACKAGE)),
                Err(DETECT_FAILED.into())
            );
        }
        // 读取 AUMID 不允许「无包」结果，已知包应用不能在这里降级。
        assert_eq!(
            query_string(|_, _| APPMODEL_ERROR_NO_PACKAGE, None),
            Err(DETECT_FAILED.into())
        );
    }

    #[test]
    fn process_identity_checks_creation_time_before_classifying() {
        let pid = std::process::id();
        let handle = ProcessHandle(unsafe {
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).unwrap()
        });
        let (path, ticks) = process_metadata(handle.0).unwrap();
        let mut instance = Instance {
            pid,
            executable: path.clone(),
            path,
            started: ticks.to_string(),
            package: None,
        };
        assert!(package_identity(&instance).is_ok());
        instance.started = (ticks + 1).to_string();
        assert_eq!(
            package_identity(&instance).err().as_deref(),
            Some(DETECT_FAILED)
        );
    }

    #[test]
    fn process_identity_checks_image_before_classifying() {
        let instance = Instance {
            pid: std::process::id(),
            executable: PathBuf::from(r"C:\not-the-running-process.exe"),
            path: PathBuf::from(r"C:\not-the-running-process.exe"),
            started: "1".into(),
            package: None,
        };
        assert_eq!(
            package_identity(&instance).err().as_deref(),
            Some(DETECT_FAILED)
        );
    }

    #[test]
    fn invalid_package_does_not_pass_preflight() {
        let package = PackageIdentity {
            full_name: "invalid\0package".into(),
            app_user_model_id: "invalid!app".into(),
        };
        assert_eq!(validate_package(&package), Err(DETECT_FAILED.into()));
    }

    #[test]
    fn package_application_list_validates_pointer_and_string_bounds() {
        let text: Vec<u16> = "example!Codex\0".encode_utf16().collect();
        let bytes = size_of::<usize>() + text.len() * size_of::<u16>();
        let mut buffer = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let base = buffer.as_mut_ptr().cast::<u8>();
        buffer[0] = unsafe { base.add(size_of::<usize>()) } as usize;
        unsafe {
            std::ptr::copy_nonoverlapping(
                text.as_ptr(),
                base.add(size_of::<usize>()).cast::<u16>(),
                text.len(),
            );
        }
        assert!(application_ids_contain(&buffer, bytes, 1, "example!Codex").unwrap());
        assert!(!application_ids_contain(&buffer, bytes, 1, "other!Codex").unwrap());
        assert!(application_ids_contain(&buffer, bytes - 2, 1, "example!Codex").is_err());
        buffer[0] = base as usize;
        assert!(application_ids_contain(&buffer, bytes, 1, "example!Codex").is_err());
        buffer[0] = (base as usize) + bytes;
        assert!(application_ids_contain(&buffer, bytes, 1, "example!Codex").is_err());
    }
}
