use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const GITHUB_UPDATE_ENDPOINT: &str =
    "https://github.com/Mintimate/codex-auth-switch/releases/latest/download/latest.json";
const CNB_UPDATE_ENDPOINT: &str = "https://cnb.cool/Mintimate/tool-forge/codex-auth-switch/-/releases/latest/download/latest.json";
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Copy, Deserialize)]
pub enum AppUpdateSource {
    #[serde(rename = "github")]
    GitHub,
    #[serde(rename = "cnb")]
    Cnb,
}

impl AppUpdateSource {
    fn endpoint(self) -> &'static str {
        match self {
            Self::GitHub => GITHUB_UPDATE_ENDPOINT,
            Self::Cnb => CNB_UPDATE_ENDPOINT,
        }
    }
}

pub struct AppUpdateState {
    pending: Mutex<Option<Update>>,
    operation_gate: tokio::sync::Mutex<()>,
}

impl Default for AppUpdateState {
    fn default() -> Self {
        Self {
            pending: Mutex::new(None),
            operation_gate: tokio::sync::Mutex::new(()),
        }
    }
}

impl AppUpdateState {
    fn clear_pending(&self) -> Result<(), String> {
        *self
            .pending
            .lock()
            .map_err(|error| format!("更新状态锁已失效: {error}"))? = None;
        Ok(())
    }

    fn store_pending(&self, update: Update) -> Result<(), String> {
        *self
            .pending
            .lock()
            .map_err(|error| format!("更新状态锁已失效: {error}"))? = Some(update);
        Ok(())
    }

    fn take_pending(&self) -> Result<Update, String> {
        self.pending
            .lock()
            .map_err(|error| format!("更新状态锁已失效: {error}"))?
            .take()
            .ok_or_else(|| "没有待安装的 Codex Auth Switch 更新，请先检查更新".to_string())
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AppUpdateStatus {
    Unsupported,
    UpToDate,
    Available,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheckResult {
    pub status: AppUpdateStatus,
    pub current_version: String,
    pub version: Option<String>,
    pub body: Option<String>,
    pub date: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
enum AppUpdateEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

fn result(status: AppUpdateStatus, reason: Option<String>) -> AppUpdateCheckResult {
    AppUpdateCheckResult {
        status,
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        version: None,
        body: None,
        date: None,
        reason,
    }
}

#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
    source: AppUpdateSource,
) -> Result<AppUpdateCheckResult, String> {
    let _guard = state.operation_gate.lock().await;

    if tauri::is_dev() {
        state.clear_pending()?;
        return Ok(result(AppUpdateStatus::Unsupported, None));
    }

    let endpoint: tauri::Url = match source.endpoint().parse() {
        Ok(endpoint) => endpoint,
        Err(error) => {
            state.clear_pending()?;
            return Ok(result(AppUpdateStatus::Error, Some(error.to_string())));
        }
    };
    let updater = match app
        .updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|builder| builder.timeout(UPDATE_CHECK_TIMEOUT).build())
    {
        Ok(updater) => updater,
        Err(error) => {
            state.clear_pending()?;
            return Ok(result(AppUpdateStatus::Error, Some(error.to_string())));
        }
    };

    let update = match updater.check().await {
        Ok(update) => update,
        Err(error) => {
            state.clear_pending()?;
            return Ok(result(AppUpdateStatus::Error, Some(error.to_string())));
        }
    };

    let Some(mut update) = update else {
        state.clear_pending()?;
        return Ok(result(AppUpdateStatus::UpToDate, None));
    };

    // GitHub Release assets can be much larger than the update manifest and may
    // be downloaded through a slower redirected CDN. Keep checks responsive,
    // but allow enough time for the signed application package itself.
    update.timeout = Some(UPDATE_DOWNLOAD_TIMEOUT);

    let check_result = AppUpdateCheckResult {
        status: AppUpdateStatus::Available,
        current_version: update.current_version.clone(),
        version: Some(update.version.clone()),
        body: update.body.clone(),
        date: update.date.as_ref().map(ToString::to_string),
        reason: None,
    };
    state.store_pending(update)?;
    Ok(check_result)
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: State<'_, AppUpdateState>,
) -> Result<bool, String> {
    let _guard = state.operation_gate.lock().await;
    let update = state.take_pending()?;
    let app_for_started = app.clone();
    let app_for_progress = app.clone();
    let app_for_finished = app.clone();
    let mut started = false;

    let download = update
        .download(
            move |chunk_length, content_length| {
                if !started {
                    let _ = app_for_started.emit(
                        "app-update-event",
                        AppUpdateEvent::Started { content_length },
                    );
                    started = true;
                }
                let _ = app_for_progress.emit(
                    "app-update-event",
                    AppUpdateEvent::Progress { chunk_length },
                );
            },
            move || {
                let _ = app_for_finished.emit("app-update-event", AppUpdateEvent::Finished);
            },
        )
        .await;

    let bytes = match download {
        Ok(bytes) => bytes,
        Err(error) => {
            state.store_pending(update)?;
            return Err(error.to_string());
        }
    };

    if let Err(error) = update.install(bytes) {
        state.store_pending(update)?;
        return Err(error.to_string());
    }
    app.request_restart();
    Ok(true)
}
