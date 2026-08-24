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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            operation_gate: Mutex::new(()),
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_usage_overview,
            save_current,
            start_device_login,
            poll_device_login,
            switch_account,
            rename_account,
            remove_account,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Codex Auth Switch");
}
