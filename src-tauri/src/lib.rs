mod app_update;
mod auth_share;
mod codex_app_server;
mod diagnostics;
mod manager;
mod usage;

use diagnostics::LocalDiagnostics;
use manager::{
    AccountManager, AccountQuota, AppStatus, CodexConfigKey, CodexContextConfig, CodexContextMode,
    CodexManagedConfig, DeviceLoginResponse,
};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use usage::{LocalUsageStats, ModelProviderState};

struct AppState {
    operation_gate: Mutex<()>,
    quota_query_gate: Mutex<()>,
    credential_refresh_gate: Mutex<()>,
    prepared_auth_transfer: Mutex<Option<PreparedAuthTransferCache>>,
}

struct PreparedAuthTransferCache {
    profile_id: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthTransferPreparation {
    qr_data_url: Option<String>,
    qr_error: Option<String>,
}

// 保留旧聚合命令，避免开发期间 WebView 热更新早于 Rust 进程重启时刷新失败。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageOverview {
    quotas: Vec<AccountQuota>,
    local: LocalUsageStats,
}

fn account_manager(app: &AppHandle) -> Result<AccountManager, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    AccountManager::from_environment(app_data_dir).map_err(|error| error.to_string())
}

async fn query_account_quotas(
    app: &AppHandle,
    state: &AppState,
) -> Result<Vec<AccountQuota>, String> {
    // 同一时间只运行一批额度刷新，避免多个 WebView 调用重复冲击远端服务。
    let _quota_guard = state.quota_query_gate.lock().await;
    // App Server 和兼容路径都可能轮换 refresh token，不能与迁移流程同时使用同一凭据。
    let _credential_guard = state.credential_refresh_gate.lock().await;
    account_manager(app)?
        .account_quotas(&state.operation_gate)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_status(app: AppHandle) -> Result<AppStatus, String> {
    account_manager(&app)?
        .status()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_local_diagnostics(app: AppHandle) -> Result<LocalDiagnostics, String> {
    let manager = account_manager(&app)?;
    Ok(diagnostics::run_local_diagnostics(
        manager.codex_home_path(),
        manager.vault_path(),
    ))
}

#[tauri::command]
fn get_codex_managed_config(app: AppHandle) -> Result<CodexManagedConfig, String> {
    account_manager(&app)?
        .codex_managed_config()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn set_codex_config_choice(
    app: AppHandle,
    state: State<'_, AppState>,
    key: CodexConfigKey,
    value: String,
) -> Result<CodexManagedConfig, String> {
    let _guard = state.operation_gate.lock().await;
    account_manager(&app)?
        .set_codex_config_choice(key, &value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn set_codex_context_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: CodexContextMode,
) -> Result<CodexContextConfig, String> {
    let _guard = state.operation_gate.lock().await;
    account_manager(&app)?
        .set_codex_context_mode(mode)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn enable_file_credential_storage(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AppStatus, String> {
    let _guard = state.operation_gate.lock().await;
    account_manager(&app)?
        .enable_file_credential_storage()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_local_usage(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LocalUsageStats, String> {
    account_manager(&app)?
        .local_usage(&state.operation_gate)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_account_quotas(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<AccountQuota>, String> {
    query_account_quotas(&app, state.inner()).await
}

#[tauri::command]
async fn get_model_provider_state(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ModelProviderState, String> {
    let _guard = state.operation_gate.lock().await;
    account_manager(&app)?
        .model_provider_state()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_usage_overview(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UsageOverview, String> {
    let manager = account_manager(&app)?;
    let local = manager
        .local_usage(&state.operation_gate)
        .await
        .map_err(|error| error.to_string())?;
    let quotas = query_account_quotas(&app, state.inner()).await?;
    Ok(UsageOverview { quotas, local })
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
async fn prepare_auth_transfer(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<AuthTransferPreparation, String> {
    let _credential_guard = state.credential_refresh_gate.lock().await;
    let _guard = state.operation_gate.lock().await;
    *state.prepared_auth_transfer.lock().await = None;
    let prepared = account_manager(&app)?
        .prepare_auth_transfer(&profile_id)
        .await
        .map_err(|error| error.to_string())?;
    let response = AuthTransferPreparation {
        qr_data_url: prepared.qr_data_url,
        qr_error: prepared.qr_error,
    };
    *state.prepared_auth_transfer.lock().await = Some(PreparedAuthTransferCache {
        profile_id,
        text: prepared.text,
    });
    Ok(response)
}

#[tauri::command]
async fn copy_auth_transfer(state: State<'_, AppState>, profile_id: String) -> Result<(), String> {
    let text = state
        .prepared_auth_transfer
        .lock()
        .await
        .as_ref()
        .filter(|prepared| prepared.profile_id == profile_id)
        .map(|prepared| prepared.text.clone())
        .ok_or_else(|| "一次性迁移内容尚未准备好，请重新打开迁移窗口".to_string())?;
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
    let _credential_guard = state.credential_refresh_gate.lock().await;
    let _guard = state.operation_gate.lock().await;
    account_manager(&app)?
        .import_auth_share_text(&text)
        .await
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
    let _credential_guard = state.credential_refresh_gate.lock().await;
    let _guard = state.operation_gate.lock().await;
    account_manager(&app)?
        .import_auth_share_qr(&image)
        .await
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            operation_gate: Mutex::new(()),
            quota_query_gate: Mutex::new(()),
            credential_refresh_gate: Mutex::new(()),
            prepared_auth_transfer: Mutex::new(None),
        })
        .manage(app_update::AppUpdateState::default())
        .invoke_handler(tauri::generate_handler![
            app_update::get_app_version,
            app_update::check_app_update,
            app_update::install_app_update,
            get_status,
            get_local_diagnostics,
            get_codex_managed_config,
            set_codex_context_mode,
            set_codex_config_choice,
            enable_file_credential_storage,
            get_local_usage,
            get_account_quotas,
            get_usage_overview,
            get_model_provider_state,
            save_current,
            start_device_login,
            poll_device_login,
            switch_account,
            rename_account,
            remove_account,
            prepare_auth_transfer,
            copy_auth_transfer,
            import_auth_from_clipboard,
            import_auth_from_qr,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Codex Auth Switch");
}
