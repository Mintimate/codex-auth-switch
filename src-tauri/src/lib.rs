mod app_update;
mod auth_share;
mod codex_app_server;
mod desktop_client;
mod device_login;
mod diagnostics;
mod hosted_login;
mod manager;
mod pricing;
mod proxy;
mod query_gate;
mod quota;
mod quota_history;
mod quota_refresh;
mod storage;
mod usage;

use diagnostics::LocalDiagnostics;
use manager::{
    AccountManager, AccountQuota, AppStatus, CodexConfigKey, CodexContextConfig, CodexContextMode,
    CodexManagedConfig, DeviceLoginResponse,
};
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;
use usage::{LocalUsageStats, ModelProviderState};

struct AppState {
    device_login: device_login::DeviceLoginState,
    hosted_login: hosted_login::HostedLoginState,
    login_start_gate: Mutex<()>,
    operation_gate: Arc<Mutex<()>>,
    query_gate: Arc<query_gate::QueryGate>,
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
    account_manager(app)?
        .account_quotas(&state.operation_gate, &state.query_gate)
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
async fn get_network_proxy() -> Result<proxy::ProxySettings, String> {
    tauri::async_runtime::spawn_blocking(proxy::get)
        .await
        .map_err(|_| "无法读取代理设置".to_string())?
}

#[tauri::command]
async fn set_network_proxy(settings: proxy::ProxySettings) -> Result<proxy::ProxySettings, String> {
    tauri::async_runtime::spawn_blocking(move || proxy::set(settings))
        .await
        .map_err(|_| "代理设置保存失败".to_string())?
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
async fn get_model_prices(app: AppHandle, refresh: bool) -> Result<pricing::ModelPrices, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用数据目录".to_string())?;
    pricing::get_prices(&directory, refresh).await
}

async fn cache_info(app: &AppHandle, clear: bool) -> Result<usage::UsageCacheInfo, String> {
    let path = account_manager(app)?.usage_cache_path();
    tauri::async_runtime::spawn_blocking(move || usage::usage_cache_info(&path, clear))
        .await
        .map_err(|_| "读取本地用量缓存失败".to_string())?
        .map_err(|_| "处理本地用量缓存失败".to_string())
}

#[tauri::command]
async fn get_usage_cache_info(app: AppHandle) -> Result<usage::UsageCacheInfo, String> {
    cache_info(&app, false).await
}

#[tauri::command]
async fn clear_usage_cache(app: AppHandle) -> Result<usage::UsageCacheInfo, String> {
    cache_info(&app, true).await
}

#[tauri::command]
async fn get_account_quotas(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<AccountQuota>, String> {
    query_account_quotas(&app, state.inner()).await
}

#[tauri::command]
async fn get_quota_history(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<quota_history::QuotaHistory, String> {
    let _guard = state.operation_gate.lock().await;
    account_manager(&app)?.quota_history()
}

#[tauri::command]
async fn clear_quota_history(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let _queries = state.query_gate.exclusive().await;
    let _guard = state.operation_gate.lock().await;
    quota_history::clear(&account_manager(&app)?.quota_history_path()).map_err(str::to_string)
}

#[tauri::command]
async fn verify_account_switch(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<desktop_client::SwitchVerification, String> {
    let _guard = state.operation_gate.lock().await;
    let manager = account_manager(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        desktop_client::verify_switch(&manager, &profile_id)
    })
    .await
    .map_err(|_| "无法检查切换结果，请重试".into())
}

const QUOTA_REFRESH_EVENT: &str = "quota-refresh-state";

fn emit_quota_state(app: &AppHandle, snapshot: quota_refresh::RefreshState) {
    let _ = app.emit(QUOTA_REFRESH_EVENT, snapshot);
}

#[tauri::command]
async fn initialize_quota_refresh(
    app: AppHandle,
    legacy_enabled: bool,
) -> Result<quota_refresh::RefreshState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<quota_refresh::QuotaRefresh>()
            .initialize(legacy_enabled)
    })
    .await
    .map_err(|_| "无法读取后台刷新设置，请重新设置开关".to_string())?
}

#[tauri::command]
fn get_quota_refresh_state(app: AppHandle) -> quota_refresh::RefreshState {
    app.state::<quota_refresh::QuotaRefresh>().snapshot()
}

#[tauri::command]
async fn set_background_quota_refresh(
    app: AppHandle,
    enabled: bool,
) -> Result<quota_refresh::RefreshState, String> {
    let handle = app.clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        handle
            .state::<quota_refresh::QuotaRefresh>()
            .set_enabled(enabled)
    })
    .await
    .map_err(|_| "保存后台刷新设置失败".to_string())??;
    emit_quota_state(&app, snapshot.clone());
    Ok(snapshot)
}

#[tauri::command]
async fn refresh_account_quotas(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_ids: Option<Vec<String>>,
) -> Result<quota_refresh::RefreshState, String> {
    app.state::<quota_refresh::QuotaRefresh>()
        .refresh(
            &account_manager(&app)?,
            &state.operation_gate,
            &state.query_gate,
            profile_ids.as_deref(),
            false,
            |snapshot| emit_quota_state(&app, snapshot),
        )
        .await
}

fn start_quota_worker(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let refresh = app.state::<quota_refresh::QuotaRefresh>();
        refresh
            .run(std::time::Duration::from_secs(30), || async {
                let state = app.state::<AppState>();
                // 只观察后端真实操作状态，不依赖前端弹窗是否仍然挂载。
                let Ok(starting_login) = state.login_start_gate.try_lock() else {
                    return;
                };
                if state.device_login.active().await || state.hosted_login.active().await {
                    return;
                }
                drop(starting_login);
                let Ok(manager) = account_manager(&app) else {
                    return;
                };
                let _ = refresh
                    .refresh(
                        &manager,
                        &state.operation_gate,
                        &state.query_gate,
                        None,
                        true,
                        |snapshot| emit_quota_state(&app, snapshot),
                    )
                    .await;
            })
            .await;
    });
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
async fn start_device_login(
    app: AppHandle,
    state: State<'_, AppState>,
    label: String,
) -> Result<DeviceLoginResponse, String> {
    let _login = state.login_start_gate.lock().await;
    if state.hosted_login.active().await {
        return Err("请先完成或取消正在进行的登录".into());
    }
    let response = account_manager(&app)?
        .start_device_login(&label)
        .await
        .map_err(|error| error.to_string())?;
    state.device_login.register(&response, label).await;
    Ok(response)
}

#[tauri::command]
async fn start_hosted_login(
    app: AppHandle,
    state: State<'_, AppState>,
    label: String,
) -> Result<hosted_login::LoginStatus, hosted_login::LoginError> {
    let _login = state.login_start_gate.lock().await;
    if state.device_login.active().await {
        return Err(hosted_login::LoginError::Busy);
    }
    let manager = account_manager(&app).map_err(|_| hosted_login::LoginError::Storage)?;
    state
        .hosted_login
        .start(
            manager,
            label,
            state.operation_gate.clone(),
            state.query_gate.clone(),
        )
        .await
}

#[tauri::command]
async fn get_hosted_login(
    state: State<'_, AppState>,
) -> Result<Option<hosted_login::LoginStatus>, hosted_login::LoginError> {
    Ok(state.hosted_login.status().await)
}

#[tauri::command]
async fn cancel_hosted_login(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<hosted_login::LoginStatus, hosted_login::LoginError> {
    state.hosted_login.cancel(&session_id).await
}

#[tauri::command]
async fn open_hosted_login(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), hosted_login::LoginError> {
    let url = state.hosted_login.auth_url(&session_id).await?;
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|_| hosted_login::LoginError::Browser)
}

#[tauri::command]
async fn copy_hosted_login(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), hosted_login::LoginError> {
    let url = state.hosted_login.auth_url(&session_id).await?;
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(url))
        .map_err(|_| hosted_login::LoginError::Clipboard)
}

#[tauri::command]
async fn poll_device_login(
    app: AppHandle,
    state: State<'_, AppState>,
    device_code: String,
) -> Result<Option<AppStatus>, String> {
    state
        .device_login
        .poll(&account_manager(&app)?, &state.operation_gate, &device_code)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn cancel_device_login(
    app: AppHandle,
    state: State<'_, AppState>,
    device_code: String,
) -> Result<AppStatus, String> {
    state.device_login.cancel(&device_code).await;
    let _guard = state.operation_gate.lock().await;
    // 若提交先于取消完成，向前端返回真实登录状态。
    account_manager(&app)?
        .status()
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
fn desktop_restart_supported() -> bool {
    desktop_client::supported()
}

#[tauri::command]
async fn switch_account_with_options(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
    restart: bool,
    on_progress: tauri::ipc::Channel<desktop_client::SwitchStage>,
) -> Result<desktop_client::SwitchResult, String> {
    let _guard = state.operation_gate.lock().await;
    let manager = account_manager(&app)?;
    // 进程检测与退出等待不能占用 WebView 主线程或异步运行时工作线程。
    tauri::async_runtime::spawn_blocking(move || {
        desktop_client::switch_account(&manager, &profile_id, restart, |stage| {
            let _ = on_progress.send(stage);
        })
    })
    .await
    .map_err(|_| "账号切换操作中断，请刷新账号状态后重试".to_string())?
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
) -> Result<manager::RemoveAccountResult, String> {
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
    let _credential_guard = state.query_gate.exclusive().await;
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
    let _credential_guard = state.query_gate.exclusive().await;
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
    let _credential_guard = state.query_gate.exclusive().await;
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
            device_login: device_login::DeviceLoginState::default(),
            hosted_login: hosted_login::HostedLoginState::default(),
            login_start_gate: Mutex::new(()),
            operation_gate: Arc::new(Mutex::new(())),
            query_gate: Arc::new(query_gate::QueryGate::default()),
            prepared_auth_transfer: Mutex::new(None),
        })
        .manage(app_update::AppUpdateState::default())
        .setup(|app| {
            app.manage(quota_refresh::QuotaRefresh::new(app.path().app_data_dir()?));
            if let Ok(app_data_dir) = app.path().app_data_dir() {
                proxy::init(app_data_dir);
            }
            start_quota_worker(app.handle().clone());
            if let Ok(manager) = account_manager(app.handle()) {
                let path = manager.usage_cache_path();
                tauri::async_runtime::spawn_blocking(move || {
                    hosted_login::cleanup_stale(&manager);
                    let _ = usage::usage_cache_info(&path, false);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_update::get_app_version,
            app_update::check_app_update,
            app_update::install_app_update,
            get_status,
            get_local_diagnostics,
            get_network_proxy,
            set_network_proxy,
            get_codex_managed_config,
            set_codex_context_mode,
            set_codex_config_choice,
            enable_file_credential_storage,
            get_local_usage,
            get_model_prices,
            get_usage_cache_info,
            clear_usage_cache,
            get_account_quotas,
            get_quota_history,
            clear_quota_history,
            verify_account_switch,
            refresh_account_quotas,
            initialize_quota_refresh,
            get_quota_refresh_state,
            set_background_quota_refresh,
            get_usage_overview,
            get_model_provider_state,
            save_current,
            start_device_login,
            poll_device_login,
            cancel_device_login,
            start_hosted_login,
            get_hosted_login,
            cancel_hosted_login,
            open_hosted_login,
            copy_hosted_login,
            switch_account,
            desktop_restart_supported,
            switch_account_with_options,
            rename_account,
            remove_account,
            prepare_auth_transfer,
            copy_auth_transfer,
            import_auth_from_clipboard,
            import_auth_from_qr,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Codex Auth Switch")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<quota_refresh::QuotaRefresh>().stop();
                tauri::async_runtime::block_on(app.state::<AppState>().hosted_login.shutdown());
            }
        });
}
