//! 实验室中的 Windows 启动入口修复。没有认证目录或账号管理器访问权限。
//! 前端只提交短期检查编号；包名、清单与启动路径始终由后端本机检测决定。

use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CHECK_LIFETIME: Duration = Duration::from_secs(5 * 60);
const UNCERTAIN_COOLDOWN: Duration = Duration::from_secs(60);
static NEXT_CHECK: AtomicU64 = AtomicU64::new(1);

// 仅接受固定脚本的输出；该结构不能序列化到 WebView。
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepairTarget {
    pub package_full_name: String,
    pub app_user_model_id: String,
    pub install_location: PathBuf,
    pub executable: PathBuf,
    pub version: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RepairError {
    Unsupported,
    NotFound,
    Ambiguous,
    Running,
    InspectFailed,
    StaleCheck,
    Busy,
    RepairFailed,
    RepairUncertain,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum InspectionStatus {
    Ready,
    Unsupported,
    NotFound,
    Ambiguous,
    Running,
    Unavailable,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Inspection {
    status: InspectionStatus,
    check_id: Option<String>,
    version: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RepairOutcome {
    Opened,
    LaunchFailed,
}

#[derive(Debug, Serialize)]
pub(crate) struct RepairResult {
    outcome: RepairOutcome,
}

struct PreparedRepair {
    check_id: String,
    target: RepairTarget,
    inspected_at: Instant,
}

#[derive(Default)]
struct RepairState {
    prepared: Option<PreparedRepair>,
    uncertain_until: Option<Instant>,
}

#[derive(Default)]
pub(crate) struct RepairService {
    state: Mutex<RepairState>,
}

pub(crate) trait RepairBackend {
    fn inspect(&self) -> Result<RepairTarget, RepairError>;
    fn register(&self, target: &RepairTarget) -> Result<(), RepairError>;
    fn launch(&self, target: &RepairTarget) -> Result<bool, RepairError>;
}

pub(crate) struct SystemBackend;

impl RepairBackend for SystemBackend {
    fn inspect(&self) -> Result<RepairTarget, RepairError> {
        #[cfg(target_os = "windows")]
        return crate::desktop_client::startup_repair_backend::inspect();
        #[cfg(not(target_os = "windows"))]
        Err(RepairError::Unsupported)
    }

    fn register(&self, target: &RepairTarget) -> Result<(), RepairError> {
        #[cfg(target_os = "windows")]
        return crate::desktop_client::startup_repair_backend::register(target);
        #[cfg(not(target_os = "windows"))]
        {
            let _ = target;
            Err(RepairError::Unsupported)
        }
    }

    fn launch(&self, target: &RepairTarget) -> Result<bool, RepairError> {
        #[cfg(target_os = "windows")]
        return crate::desktop_client::startup_repair_backend::launch(target);
        #[cfg(not(target_os = "windows"))]
        {
            let _ = target;
            Err(RepairError::Unsupported)
        }
    }
}

impl RepairService {
    pub(crate) fn inspect(&self, backend: &impl RepairBackend) -> Result<Inspection, RepairError> {
        let mut state = self.state.try_lock().map_err(|_| RepairError::Busy)?;
        state.prepared = None;
        if state
            .uncertain_until
            .is_some_and(|until| Instant::now() < until)
        {
            return Err(RepairError::RepairUncertain);
        }
        state.uncertain_until = None;
        match backend.inspect() {
            Ok(target) => {
                let check_id = format!(
                    "{:x}-{:x}",
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos(),
                    NEXT_CHECK.fetch_add(1, Ordering::Relaxed)
                );
                let report = Inspection {
                    status: InspectionStatus::Ready,
                    check_id: Some(check_id.clone()),
                    version: Some(target.version.clone()),
                };
                state.prepared = Some(PreparedRepair {
                    check_id,
                    target,
                    inspected_at: Instant::now(),
                });
                Ok(report)
            }
            Err(error) => Ok(Inspection {
                status: match error {
                    RepairError::Unsupported => InspectionStatus::Unsupported,
                    RepairError::NotFound => InspectionStatus::NotFound,
                    RepairError::Ambiguous => InspectionStatus::Ambiguous,
                    RepairError::Running => InspectionStatus::Running,
                    _ => InspectionStatus::Unavailable,
                },
                check_id: None,
                version: None,
            }),
        }
    }

    pub(crate) fn repair(
        &self,
        check_id: &str,
        backend: &impl RepairBackend,
    ) -> Result<RepairResult, RepairError> {
        // IPC 同时持有 operation_gate；此锁保证跨面板卸载或直接重复 IPC 也不会重入。
        let mut state = self.state.try_lock().map_err(|_| RepairError::Busy)?;
        let prepared = state.prepared.take().ok_or(RepairError::StaleCheck)?;
        if prepared.check_id != check_id || prepared.inspected_at.elapsed() >= CHECK_LIFETIME {
            return Err(RepairError::StaleCheck);
        }
        // 检测后应用可能更新、启动或被卸载；此时必须重新确认，不能修另一个目标。
        let current = backend.inspect()?;
        if current != prepared.target {
            return Err(RepairError::StaleCheck);
        }
        if let Err(error) = backend.register(&current) {
            if error == RepairError::RepairUncertain {
                // PowerShell 退出不代表系统部署服务已经停止，禁止立即再次提交修复。
                state.uncertain_until = Some(Instant::now() + UNCERTAIN_COOLDOWN);
            }
            return Err(error);
        }
        // 已完成注册后，激活失败必须保留「入口已修复」的事实，不能报告注册未发生。
        let opened = backend.launch(&current).unwrap_or(false);
        Ok(RepairResult {
            outcome: if opened {
                RepairOutcome::Opened
            } else {
                RepairOutcome::LaunchFailed
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct FakeBackend {
        target: RefCell<Result<RepairTarget, RepairError>>,
        registration: RefCell<Result<(), RepairError>>,
        launch: RefCell<Result<bool, RepairError>>,
        calls: RefCell<Vec<&'static str>>,
    }

    impl FakeBackend {
        fn new() -> Self {
            Self {
                target: RefCell::new(Ok(RepairTarget {
                    package_full_name: "private-package-name".into(),
                    app_user_model_id: "private-application-id".into(),
                    install_location: PathBuf::from("/private-install-path"),
                    executable: PathBuf::from("/private-install-path/ChatGPT.exe"),
                    version: "1.2.3.4".into(),
                })),
                registration: RefCell::new(Ok(())),
                launch: RefCell::new(Ok(true)),
                calls: RefCell::new(vec![]),
            }
        }
    }

    impl RepairBackend for FakeBackend {
        fn inspect(&self) -> Result<RepairTarget, RepairError> {
            self.calls.borrow_mut().push("inspect");
            self.target.borrow().clone()
        }
        fn register(&self, _: &RepairTarget) -> Result<(), RepairError> {
            self.calls.borrow_mut().push("register");
            *self.registration.borrow()
        }
        fn launch(&self, _: &RepairTarget) -> Result<bool, RepairError> {
            self.calls.borrow_mut().push("launch");
            *self.launch.borrow()
        }
    }

    #[test]
    fn repair_requires_a_fresh_check_and_rechecks_before_mutation() {
        let service = RepairService::default();
        let backend = FakeBackend::new();
        assert_eq!(
            service.repair("not-checked", &backend).unwrap_err(),
            RepairError::StaleCheck
        );
        assert!(backend.calls.borrow().is_empty());
        let inspection = service.inspect(&backend).unwrap();
        assert_eq!(&*backend.calls.borrow(), &["inspect"]);
        let check = inspection.check_id.unwrap();
        let result = service.repair(&check, &backend).unwrap();
        assert_eq!(result.outcome, RepairOutcome::Opened);
        assert_eq!(
            &*backend.calls.borrow(),
            &["inspect", "inspect", "register", "launch"]
        );
        assert_eq!(
            service.repair(&check, &backend).unwrap_err(),
            RepairError::StaleCheck
        );
    }

    #[test]
    fn reports_expose_only_status_version_and_check_id() {
        let service = RepairService::default();
        let backend = FakeBackend::new();
        let inspection = service.inspect(&backend).unwrap();
        let value = serde_json::to_value(&inspection).unwrap();
        assert_eq!(value["version"], "1.2.3.4");
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert!(!value.to_string().contains("private-"));
    }

    #[test]
    fn unavailable_running_or_ambiguous_installs_are_never_repaired() {
        for error in [
            RepairError::Unsupported,
            RepairError::NotFound,
            RepairError::Ambiguous,
            RepairError::Running,
            RepairError::InspectFailed,
        ] {
            let service = RepairService::default();
            let backend = FakeBackend::new();
            *backend.target.borrow_mut() = Err(error);
            let inspection = service.inspect(&backend).unwrap();
            assert_ne!(inspection.status, InspectionStatus::Ready);
            assert!(inspection.check_id.is_none());
            assert!(inspection.version.is_none());
            assert_eq!(
                service.repair("unchecked", &backend).unwrap_err(),
                RepairError::StaleCheck
            );
            assert_eq!(&*backend.calls.borrow(), &["inspect"]);
        }
    }

    #[test]
    fn a_changed_or_newly_running_target_invalidates_the_check() {
        for running in [false, true] {
            let service = RepairService::default();
            let backend = FakeBackend::new();
            let check = service.inspect(&backend).unwrap().check_id.unwrap();
            if running {
                *backend.target.borrow_mut() = Err(RepairError::Running);
            } else {
                backend.target.borrow_mut().as_mut().unwrap().executable =
                    "/another-app.exe".into();
            }
            assert_eq!(
                service.repair(&check, &backend).unwrap_err(),
                if running {
                    RepairError::Running
                } else {
                    RepairError::StaleCheck
                }
            );
            assert_eq!(&*backend.calls.borrow(), &["inspect", "inspect"]);
            assert_eq!(
                service.repair(&check, &backend).unwrap_err(),
                RepairError::StaleCheck
            );
        }
    }

    #[test]
    fn expired_checks_and_replaced_checks_do_not_modify_registration() {
        let service = RepairService::default();
        let backend = FakeBackend::new();
        let check = service.inspect(&backend).unwrap().check_id.unwrap();
        service
            .state
            .lock()
            .unwrap()
            .prepared
            .as_mut()
            .unwrap()
            .inspected_at = Instant::now() - CHECK_LIFETIME;
        assert_eq!(
            service.repair(&check, &backend).unwrap_err(),
            RepairError::StaleCheck
        );
        let previous = service.inspect(&backend).unwrap().check_id.unwrap();
        let latest = service.inspect(&backend).unwrap().check_id.unwrap();
        assert_ne!(previous, latest);
        assert_eq!(
            service.repair(&previous, &backend).unwrap_err(),
            RepairError::StaleCheck
        );
        assert!(!backend.calls.borrow().contains(&"register"));
    }

    #[test]
    fn failed_or_uncertain_registration_never_launches_or_retries() {
        for error in [RepairError::RepairFailed, RepairError::RepairUncertain] {
            let service = RepairService::default();
            let backend = FakeBackend::new();
            *backend.registration.borrow_mut() = Err(error);
            let check = service.inspect(&backend).unwrap().check_id.unwrap();
            assert_eq!(service.repair(&check, &backend).unwrap_err(), error);
            assert_eq!(
                service.repair(&check, &backend).unwrap_err(),
                RepairError::StaleCheck
            );
            assert!(!backend.calls.borrow().contains(&"launch"));
            if error == RepairError::RepairUncertain {
                assert_eq!(
                    service.inspect(&backend).unwrap_err(),
                    RepairError::RepairUncertain
                );
                assert_eq!(
                    &*backend.calls.borrow(),
                    &["inspect", "inspect", "register"]
                );
            }
        }
    }

    #[test]
    fn launch_failure_reports_completed_registration() {
        for launch in [Ok(false), Err(RepairError::InspectFailed)] {
            let service = RepairService::default();
            let backend = FakeBackend::new();
            *backend.launch.borrow_mut() = launch;
            let check = service.inspect(&backend).unwrap().check_id.unwrap();
            let result = service.repair(&check, &backend).unwrap();
            assert_eq!(result.outcome, RepairOutcome::LaunchFailed);
            assert_eq!(
                serde_json::to_value(result).unwrap(),
                serde_json::json!({"outcome": "launchFailed"})
            );
        }
    }

    #[test]
    fn overlapping_calls_do_not_queue_repair_operations() {
        let service = RepairService::default();
        let backend = FakeBackend::new();
        let _guard = service.state.lock().unwrap();
        assert_eq!(service.inspect(&backend).unwrap_err(), RepairError::Busy);
        assert_eq!(
            service.repair("check", &backend).unwrap_err(),
            RepairError::Busy
        );
        assert!(backend.calls.borrow().is_empty());
    }
}
