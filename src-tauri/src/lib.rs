mod app_update;
mod auth_share;
mod manager;
mod usage;

use manager::{AccountManager, AppStatus, DeviceLoginResponse, UsageOverview};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

struct AppState {
    operation_gate: Mutex<()>,
}

fn account_manager(app: &AppHandle) -> Result<AccountManager, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    AccountManager::from_environment(app_data_dir).map_err(|error| error.to_string())
}

#[tauri::command]
fn get_status(app: AppHandle) -> Result<AppStatus, String> {
    account_manager(&app)?
        .status()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_usage_overview(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UsageOverview, String> {
    let _guard = state.operation_gate.lock().await;
    account_manager(&app)?
        .usage_overview()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn save_current(
    app: AppHandle,
    state: State<'_, AppState>,
    label: String,
) -> Result<AppStatus, String> {
    let _guard = state.operation_gate.lock().await;
    account_manager(&app)?
        .save_current(&label)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn start_device_login(app: AppHandle, label: String) -> Result<DeviceLoginResponse, String> {
    account_manager(&app)?
        .start_device_login(&label)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn poll_device_login(
    app: AppHandle,
    state: State<'_, AppState>,
    device_code: String,
    user_code: String,
    label: String,
) -> Result<Option<AppStatus>, String> {
    let _guard = state.operation_gate.lock().await;
    account_manager(&app)?
        .poll_device_login(&device_code, &user_code, &label)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn switch_account(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<AppStatus, String> {
    let _guard = state.operation_gate.lock().await;
    account_manager(&app)?
        .switch_account(&profile_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn rename_account(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    label: String,
) -> Result<AppStatus, String> {
    let _guard = state.operation_gate.lock().await;
    account_manager(&app)?
        .rename_account(&profile_id, &label)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn remove_account(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<AppStatus, String> {
    let _guard = state.operation_gate.lock().await;
    account_manager(&app)?
        .remove_account(&profile_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn copy_auth_share(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), String> {
    let text = {
        let _guard = state.operation_gate.lock().await;
        account_manager(&app)?
            .auth_share_text(&profile_id)
            .map_err(|error| error.to_string())?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|_| "无法访问系统剪贴板".to_string())?;
        clipboard
            .set_text(text)
            .map_err(|_| "无法写入系统剪贴板".to_string())
    })
    .await
    .map_err(|_| "无法访问系统剪贴板".to_string())?
}

#[tauri::command]
async fn get_auth_share_qr(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<String, String> {
    let _guard = state.operation_gate.lock().await;
    account_manager(&app)?
        .auth_share_qr(&profile_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn import_auth_from_clipboard(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AppStatus, String> {
    let text = tauri::async_runtime::spawn_blocking(move || {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|_| "无法访问系统剪贴板".to_string())?;
        clipboard
            .get_text()
            .map_err(|_| "无法读取系统剪贴板中的文本".to_string())
    })
    .await
    .map_err(|_| "无法访问系统剪贴板".to_string())??;
    let _guard = state.operation_gate.lock().await;
    account_manager(&app)?
        .import_auth_share_text(&text)
        .map_err(|error| error.to_string())
}

// 图片以 base64 字符串过 IPC：number[] 会让 12MB 图片膨胀成千万级 JSON 数组元素，
// 序列化与解析的开销都远大于传输本身。
#[tauri::command]
async fn import_auth_from_qr(
    app: AppHandle,
    state: State<'_, AppState>,
    image: String,
) -> Result<AppStatus, String> {
    let _guard = state.operation_gate.lock().await;
    account_manager(&app)?
        .import_auth_share_qr(&image)
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            operation_gate: Mutex::new(()),
        })
        .manage(app_update::AppUpdateState::default())
        .invoke_handler(tauri::generate_handler![
            app_update::get_app_version,
            app_update::check_app_update,
            app_update::install_app_update,
            get_status,
            get_usage_overview,
            save_current,
            start_device_login,
            poll_device_login,
            switch_account,
            rename_account,
            remove_account,
            copy_auth_share,
            get_auth_share_qr,
            import_auth_from_clipboard,
            import_auth_from_qr,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Codex Auth Switch");
}
