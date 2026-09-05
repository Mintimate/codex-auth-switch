use crate::manager::{AccountManager, AppStatus, DeviceLoginResponse, ManagerError};
use serde_json::Value;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

#[derive(Default)]
pub(crate) struct DeviceLoginState {
    session: Mutex<Option<Arc<LoginSession>>>,
}

// 不派生 Debug / Serialize，配对信息和登录结果仅在后端会话中使用。
struct LoginSession {
    device_code: String,
    user_code: String,
    label: String,
    expires_at: Instant,
    polling: AtomicBool,
}

impl DeviceLoginState {
    pub async fn register(&self, response: &DeviceLoginResponse, label: String) {
        *self.session.lock().await = Some(Arc::new(LoginSession {
            device_code: response.device_code.clone(),
            user_code: response.user_code.clone(),
            label,
            expires_at: Instant::now() + Duration::from_secs(response.expires_in.min(86_400)),
            polling: AtomicBool::new(false),
        }));
    }

    pub async fn cancel(&self, device_code: &str) {
        let mut session = self.session.lock().await;
        if session
            .as_ref()
            .is_some_and(|session| session.device_code == device_code)
        {
            *session = None;
        }
    }

    async fn begin_poll(
        &self,
        device_code: &str,
    ) -> Result<Option<Arc<LoginSession>>, ManagerError> {
        let mut current = self.session.lock().await;
        let session = current.as_ref().ok_or(ManagerError::DeviceLoginCancelled)?;
        if session.device_code != device_code {
            return Err(ManagerError::DeviceLoginCancelled);
        }
        if Instant::now() >= session.expires_at {
            *current = None;
            return Err(ManagerError::DeviceCodeExpired);
        }
        if session.polling.swap(true, Ordering::SeqCst) {
            return Ok(None);
        }
        Ok(Some(Arc::clone(session)))
    }

    pub async fn poll(
        &self,
        manager: &AccountManager,
        operation_gate: &Mutex<()>,
        device_code: &str,
    ) -> Result<Option<AppStatus>, ManagerError> {
        let Some(session) = self.begin_poll(device_code).await? else {
            return Ok(None);
        };
        let result = manager
            .poll_device_auth(&session.device_code, &session.user_code)
            .await;
        // 网络等待不占全局锁；提交与其他文件操作串行，取消与提交在会话锁上排序。
        let _guard = operation_gate.lock().await;
        self.finish_poll(&session, result, |auth, label| {
            manager.complete_device_login(auth, label)
        })
        .await
    }

    async fn finish_poll(
        &self,
        session: &Arc<LoginSession>,
        result: Result<Option<Value>, ManagerError>,
        commit: impl FnOnce(Value, &str) -> Result<AppStatus, ManagerError>,
    ) -> Result<Option<AppStatus>, ManagerError> {
        let mut current = self.session.lock().await;
        if !current
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            return Err(ManagerError::DeviceLoginCancelled);
        }
        if Instant::now() >= session.expires_at {
            *current = None;
            return Err(ManagerError::DeviceCodeExpired);
        }
        match result {
            Ok(None) => {
                session.polling.store(false, Ordering::SeqCst);
                Ok(None)
            }
            Ok(Some(auth)) => {
                *current = None;
                // 持有会话锁直到同步写入结束；取消返回后不会再发生此会话的写入。
                commit(auth, &session.label).map(Some)
            }
            Err(error) => {
                *current = None;
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn response(code: &str) -> DeviceLoginResponse {
        DeviceLoginResponse {
            device_code: code.to_string(),
            user_code: "TEST-CODE".to_string(),
            verification_uri: "https://example.invalid".to_string(),
            expires_in: 900,
            interval: 8,
        }
    }

    #[test]
    fn cancellation_prevents_an_in_flight_result_from_committing() {
        tauri::async_runtime::block_on(async {
            let state = DeviceLoginState::default();
            state.register(&response("first"), "测试账号".into()).await;
            let ticket = state.begin_poll("first").await.unwrap().unwrap();
            state.cancel("first").await;
            let result = state
                .finish_poll(&ticket, Ok(Some(json!({}))), |_, _| {
                    panic!("已取消登录不得提交")
                })
                .await;
            assert!(matches!(result, Err(ManagerError::DeviceLoginCancelled)));
            assert!(matches!(
                state.begin_poll("first").await,
                Err(ManagerError::DeviceLoginCancelled)
            ));
        });
    }

    #[test]
    fn late_results_and_cancellation_do_not_affect_a_new_session() {
        tauri::async_runtime::block_on(async {
            let state = DeviceLoginState::default();
            state.register(&response("first"), "旧账号".into()).await;
            let old = state.begin_poll("first").await.unwrap().unwrap();
            state.register(&response("second"), "新账号".into()).await;
            state.cancel("first").await;
            assert!(matches!(
                state
                    .finish_poll(&old, Ok(Some(json!({}))), |_, _| panic!("旧会话不得提交"))
                    .await,
                Err(ManagerError::DeviceLoginCancelled)
            ));
            assert!(state.begin_poll("second").await.unwrap().is_some());
        });
    }

    #[test]
    fn duplicate_polls_are_skipped_and_pending_result_allows_retry() {
        tauri::async_runtime::block_on(async {
            let state = DeviceLoginState::default();
            state.register(&response("first"), "测试账号".into()).await;
            let ticket = state.begin_poll("first").await.unwrap().unwrap();
            assert!(state.begin_poll("first").await.unwrap().is_none());
            assert!(state
                .finish_poll(&ticket, Ok(None), |_, _| panic!("等待授权时不得提交"))
                .await
                .unwrap()
                .is_none());
            assert!(state.begin_poll("first").await.unwrap().is_some());
        });
    }

    #[test]
    fn expired_session_cannot_start_a_request() {
        tauri::async_runtime::block_on(async {
            let state = DeviceLoginState::default();
            let mut expired = response("expired");
            expired.expires_in = 0;
            state.register(&expired, "测试账号".into()).await;
            assert!(matches!(
                state.begin_poll("expired").await,
                Err(ManagerError::DeviceCodeExpired)
            ));
        });
    }

    #[test]
    fn successful_login_uses_registered_label_and_commits_only_once() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::TempDir::new().unwrap();
            let manager = AccountManager::new(root.path().join("codex"), root.path().join("app"));
            let state = DeviceLoginState::default();
            state.register(&response("first"), "测试账号".into()).await;
            let ticket = state.begin_poll("first").await.unwrap().unwrap();
            let auth = json!({"auth_mode":"chatgpt","tokens":{"account_id":"test-account","access_token":"synthetic-access","refresh_token":"synthetic-refresh"}});
            let status = state
                .finish_poll(&ticket, Ok(Some(auth)), |auth, label| {
                    manager.complete_device_login(auth, label)
                })
                .await
                .unwrap()
                .unwrap();
            assert_eq!(status.active_account_id.as_deref(), Some("test-account"));
            assert_eq!(status.accounts[0].label, "测试账号");
            assert!(matches!(
                state
                    .finish_poll(&ticket, Ok(Some(json!({}))), |_, _| panic!(
                        "同一授权不得重复提交"
                    ))
                    .await,
                Err(ManagerError::DeviceLoginCancelled)
            ));
        });
    }
}
