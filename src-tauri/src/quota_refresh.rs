//! 进程内额度刷新服务。调度、缓存和偏好均由 Rust 持有，不依赖 WebView 生命周期。
use crate::{
    manager::AccountManager, query_gate::QueryGate, quota::AccountQuota, storage::atomic_write,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    future::Future,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex as AsyncMutex, Notify};

const INTERVAL: Duration = Duration::from_secs(15 * 60);
const MAX_DELAY: Duration = Duration::from_secs(2 * 60 * 60);
const SETTINGS_ERROR: &str = "无法读取后台刷新设置，请重新设置开关";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Preference {
    enabled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshState {
    pub enabled: bool,
    pub revision: u64,
    pub quotas: Vec<AccountQuota>,
    pub refreshing_ids: Vec<String>,
    pub errors: HashMap<String, String>,
}

#[derive(Default)]
struct Attempt {
    in_flight: bool,
    request_id: u64,
    finished: Option<Instant>,
    failures: u32,
}
impl Attempt {
    fn due(&self, now: Instant) -> bool {
        let delay = (INTERVAL * 2_u32.pow(self.failures.min(5))).min(MAX_DELAY);
        !self.in_flight
            && self
                .finished
                .is_none_or(|at| now.saturating_duration_since(at) >= delay)
    }
    fn finish(&mut self, success: bool, now: Instant) {
        if !self.in_flight {
            return;
        }
        self.in_flight = false;
        self.finished = Some(now);
        self.failures = if success {
            0
        } else {
            (self.failures + 1).min(5)
        };
    }
}

#[derive(Default)]
struct Runtime {
    enabled: Option<bool>,
    settings_error: bool,
    stopped: bool,
    revision: u64,
    attempts: HashMap<String, Attempt>,
    quotas: HashMap<String, AccountQuota>,
    errors: HashMap<String, String>,
}
impl Runtime {
    fn snapshot(&self) -> RefreshState {
        RefreshState {
            enabled: self.enabled.unwrap_or(false),
            revision: self.revision,
            quotas: self.quotas.values().cloned().collect(),
            refreshing_ids: self
                .attempts
                .iter()
                .filter(|(_, a)| a.in_flight)
                .map(|(id, _)| id.clone())
                .collect(),
            errors: self.errors.clone(),
        }
    }
    fn begin(
        &mut self,
        profiles: &[String],
        selected: Option<&[String]>,
        automatic: bool,
        now: Instant,
    ) -> Vec<String> {
        self.revision += 1;
        // 正在进行的查询保留至完成，防止删除 / 重新添加同一账号时产生并发请求。
        self.attempts
            .retain(|id, a| profiles.contains(id) || a.in_flight);
        self.quotas.retain(|id, _| profiles.contains(id));
        self.errors.retain(|id, _| profiles.contains(id));
        if self.stopped || (automatic && self.enabled != Some(true)) {
            return vec![];
        }
        let ids = profiles
            .iter()
            .filter(|id| selected.is_none_or(|ids| ids.contains(id)))
            .filter(|id| {
                self.attempts
                    .get(*id)
                    .is_none_or(|a| if automatic { a.due(now) } else { !a.in_flight })
            })
            .cloned()
            .collect::<Vec<_>>();
        for id in &ids {
            let attempt = self.attempts.entry(id.clone()).or_default();
            attempt.in_flight = true;
            attempt.request_id = self.revision;
            self.errors.remove(id);
        }
        ids
    }
    fn accept(&mut self, request_id: u64, quota: AccountQuota, now: Instant) {
        let Some(attempt) = self
            .attempts
            .get_mut(&quota.profile_id)
            .filter(|a| a.in_flight && a.request_id == request_id)
        else {
            return;
        };
        attempt.finish(quota.success, now);
        if quota.success {
            self.errors.remove(&quota.profile_id);
        } else {
            self.errors.insert(
                quota.profile_id.clone(),
                quota.error.clone().unwrap_or_else(|| "额度查询失败".into()),
            );
        }
        // 查询失败保留成功快照及原始查询时间，错误与数据分开。
        if quota.success
            || !self
                .quotas
                .get(&quota.profile_id)
                .is_some_and(|q| q.success)
        {
            self.quotas.insert(quota.profile_id.clone(), quota);
        }
        self.revision += 1;
    }
    fn finish(&mut self, request_id: u64, ids: &[String], error: Option<String>, now: Instant) {
        for id in ids {
            if let Some(a) = self
                .attempts
                .get_mut(id)
                .filter(|a| a.in_flight && a.request_id == request_id)
            {
                a.finish(false, now);
                self.errors.insert(
                    id.clone(),
                    error.clone().unwrap_or_else(|| "额度查询失败".into()),
                );
            }
        }
        self.revision += 1;
    }
}

pub struct QuotaRefresh {
    path: PathBuf,
    runtime: Mutex<Runtime>,
    wake: Notify,
}
impl QuotaRefresh {
    pub fn new(directory: PathBuf) -> Self {
        let path = directory.join("quota-refresh.v1.json");
        let preference = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Preference>(&bytes)
                .map(|p| Some(p.enabled))
                .map_err(|_| ()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(()),
        };
        Self {
            path,
            runtime: Mutex::new(Runtime {
                enabled: preference.as_ref().ok().copied().flatten(),
                settings_error: preference.is_err(),
                ..Runtime::default()
            }),
            wake: Notify::new(),
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Runtime> {
        self.runtime.lock().unwrap_or_else(|e| e.into_inner())
    }
    pub fn snapshot(&self) -> RefreshState {
        self.lock().snapshot()
    }
    pub fn enabled(&self) -> bool {
        self.lock().enabled == Some(true)
    }
    pub fn initialize(&self, legacy_enabled: bool) -> Result<RefreshState, String> {
        let mut runtime = self.lock();
        if runtime.settings_error {
            return Err(SETTINGS_ERROR.into());
        }
        // 只在首次迁移时采用 WebView 的旧偏好，重载不能覆盖 Rust 中的设置。
        if runtime.enabled.is_none() {
            self.save_preference(&mut runtime, legacy_enabled)?;
        }
        Ok(runtime.snapshot())
    }
    fn save_preference(&self, runtime: &mut Runtime, enabled: bool) -> Result<(), String> {
        let bytes =
            serde_json::to_vec(&Preference { enabled }).map_err(|_| "保存后台刷新设置失败")?;
        atomic_write(&self.path, &bytes).map_err(|_| "保存后台刷新设置失败")?;
        runtime.enabled = Some(enabled);
        runtime.settings_error = false;
        runtime.revision += 1;
        self.wake.notify_one();
        Ok(())
    }
    pub fn set_enabled(&self, enabled: bool) -> Result<RefreshState, String> {
        let mut runtime = self.lock();
        self.save_preference(&mut runtime, enabled)?;
        Ok(runtime.snapshot())
    }
    pub fn stop(&self) {
        self.lock().stopped = true;
        self.wake.notify_one();
    }
    pub async fn run<F, Fut>(&self, poll_every: Duration, mut tick: F)
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = ()>,
    {
        loop {
            if self.lock().stopped {
                break;
            }
            if self.enabled() {
                tick().await;
            }
            // 每轮重新等待，休眠后不补跑过去的轮次；开关变化可以立即唤醒。
            let _ = tokio::time::timeout(poll_every, self.wake.notified()).await;
        }
    }
    pub async fn refresh(
        &self,
        manager: &AccountManager,
        operation_gate: &AsyncMutex<()>,
        query_gate: &QueryGate,
        selected: Option<&[String]>,
        automatic: bool,
        on_change: impl Fn(RefreshState),
    ) -> Result<RefreshState, String> {
        let profiles = {
            let _guard = operation_gate.lock().await;
            let status = manager.status().map_err(|e| e.to_string())?;
            if !status.supported {
                return Ok(self.snapshot());
            }
            status
                .accounts
                .into_iter()
                .map(|a| a.id)
                .collect::<Vec<_>>()
        };
        let (request_id, ids) = {
            let mut runtime = self.lock();
            let ids = runtime.begin(&profiles, selected, automatic, Instant::now());
            (runtime.revision, ids)
        };
        if ids.is_empty() {
            return Ok(self.snapshot());
        }
        on_change(self.snapshot());
        let outcome = manager
            .account_quotas_with_updates(operation_gate, query_gate, Some(&ids), |quota| {
                self.lock().accept(request_id, quota, Instant::now());
                on_change(self.snapshot());
            })
            .await;
        self.lock().finish(
            request_id,
            &ids,
            outcome.err().map(|e| e.to_string()),
            Instant::now(),
        );
        let snapshot = self.snapshot();
        on_change(snapshot.clone());
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    fn ids() -> Vec<String> {
        vec!["a".into(), "b".into()]
    }
    fn quota(success: bool) -> AccountQuota {
        AccountQuota {
            profile_id: "a".into(),
            account_id: "a".into(),
            label: "test".into(),
            primary: None,
            secondary: None,
            buckets: vec![],
            reset_credits: None,
            plan_type: None,
            official_usage: None,
            source: None,
            success,
            error: (!success).then(|| "test failure".into()),
            queried_at: 100,
            history_warning: None,
        }
    }
    #[test]
    fn manual_and_automatic_requests_share_schedule_and_preserve_success() {
        let mut r = Runtime {
            enabled: Some(true),
            ..Runtime::default()
        };
        let now = Instant::now();
        assert_eq!(r.begin(&ids(), None, true, now), ids());
        let first_request = r.revision;
        assert!(r.begin(&ids(), None, false, now).is_empty());
        r.accept(first_request, quota(true), now);
        r.finish(first_request, &ids(), None, now);
        assert!(r
            .begin(&ids(), None, true, now + INTERVAL - Duration::from_secs(1))
            .is_empty());
        assert_eq!(r.begin(&ids(), None, true, now + INTERVAL), vec!["a"]);
        r.accept(r.attempts["a"].request_id, quota(false), now + INTERVAL);
        assert!(r.snapshot().quotas[0].success);
        assert!(r.snapshot().errors.contains_key("a"));
        assert!(r
            .begin(&ids(), Some(&["a".into()]), true, now + INTERVAL * 2)
            .is_empty());
        assert_eq!(
            r.begin(&ids(), Some(&["a".into()]), false, now + INTERVAL * 2),
            vec!["a"]
        );
    }
    #[test]
    fn old_batch_completion_does_not_finish_a_new_manual_query() {
        let mut r = Runtime {
            enabled: Some(true),
            ..Runtime::default()
        };
        let now = Instant::now();
        r.begin(&ids(), None, true, now);
        let old = r.revision;
        r.accept(old, quota(true), now);
        r.begin(&ids(), Some(&["a".into()]), false, now);
        let new = r.revision;
        r.finish(old, &ids(), Some("old batch error".into()), now);
        r.accept(old, quota(false), now);
        assert!(r.attempts["a"].in_flight);
        assert!(!r.errors.contains_key("a"));
        r.accept(new, quota(true), now);
        assert!(!r.attempts["a"].in_flight);
    }
    #[test]
    fn disabled_auto_refresh_does_not_block_manual_queries_or_replay_removed_profiles() {
        let mut r = Runtime::default();
        let now = Instant::now();
        assert!(r.begin(&ids(), None, true, now).is_empty());
        assert_eq!(r.begin(&ids(), None, false, now), ids());
        let request = r.revision;
        r.accept(request, quota(true), now);
        r.finish(request, &ids(), None, now);
        r.begin(&[], None, true, now);
        assert!(r.snapshot().quotas.is_empty());
        r.enabled = Some(true);
        assert_eq!(r.begin(&ids(), None, true, now), ids());
    }
    #[test]
    fn backoff_is_bounded_and_wake_has_no_catch_up() {
        let mut a = Attempt::default();
        let mut now = Instant::now();
        for minutes in [30, 60, 120, 120, 120, 120] {
            a.in_flight = true;
            a.finish(false, now);
            a.finish(false, now); // 重复结果不会再次累加退避。
            let delay = Duration::from_secs(minutes * 60);
            assert!(!a.due(now + delay - Duration::from_secs(1)));
            now += delay;
            assert!(a.due(now));
        }
        now += Duration::from_secs(10 * 60 * 60);
        a.in_flight = true;
        a.finish(true, now);
        assert!(!a.due(now));
        assert!(a.due(now + INTERVAL));
    }
    #[test]
    fn preferences_survive_restart_and_stale_frontend_migration() {
        let root = tempfile::tempdir().unwrap();
        let service = QuotaRefresh::new(root.path().into());
        assert!(!service.enabled()); // 迁移前不抢跑，尊重旧版主动关闭。
        assert!(!service.initialize(false).unwrap().enabled);
        service.set_enabled(true).unwrap();
        assert!(service.initialize(false).unwrap().enabled);
        assert!(QuotaRefresh::new(root.path().into()).enabled());
        fs::write(&service.path, b"invalid").unwrap();
        let broken = QuotaRefresh::new(root.path().into());
        assert!(broken.initialize(true).is_err());
        assert!(!broken.enabled());
        broken.set_enabled(false).unwrap();
        assert!(!QuotaRefresh::new(root.path().into()).enabled());
    }
    #[test]
    fn native_loop_works_without_a_webview_and_stops_with_the_app() {
        tauri::async_runtime::block_on(async {
            let root = tempfile::tempdir().unwrap();
            let service = Arc::new(QuotaRefresh::new(root.path().into()));
            service.initialize(true).unwrap();
            let ticks = Arc::new(AtomicUsize::new(0));
            let worker = service.clone();
            let count = ticks.clone();
            let task = tauri::async_runtime::spawn(async move {
                worker
                    .run(Duration::from_millis(5), || async {
                        count.fetch_add(1, Ordering::SeqCst);
                    })
                    .await;
            });
            tokio::time::timeout(Duration::from_secs(2), async {
                while ticks.load(Ordering::SeqCst) < 3 {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            service.stop();
            task.await.unwrap();
            let stopped = ticks.load(Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert_eq!(ticks.load(Ordering::SeqCst), stopped);
        });
    }
}
