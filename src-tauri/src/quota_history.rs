//! 仅保存额度观测值，不保存账号邮箱、认证数据、服务响应或会话正文。
use crate::{
    quota::{AccountQuota, UsageWindow},
    storage::atomic_write,
};
use serde::{Deserialize, Serialize};
use std::{fs, io::Read, path::Path};

const RETENTION_DAYS: u64 = 30;
const MAX_POINTS: usize = 12_000;
const MAX_PROFILE_POINTS: usize = 2_000;
const MAX_BYTES: u64 = 8 * 1024 * 1024;
const READ_ERROR: &str = "无法读取额度变化记录，可清空本机额度历史后重试";
const WRITE_ERROR: &str = "额度已更新，但本地变化记录保存失败";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuotaPoint {
    pub profile_id: String,
    pub queried_at: u64,
    pub bucket_id: String,
    pub window: WindowKind,
    pub window_minutes: Option<u64>,
    pub used_percent: f64,
    pub resets_at: Option<u64>,
    pub source: Source,
    pub plan_type: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum WindowKind {
    Primary,
    Secondary,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    AppServer,
    Compatibility,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HistoryFile {
    version: u32,
    points: Vec<QuotaPoint>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaHistory {
    pub points: Vec<QuotaPoint>,
    pub retention_days: u64,
    pub max_points: usize,
    pub max_profile_points: usize,
}

fn valid(point: &QuotaPoint, now: u64) -> bool {
    point.used_percent.is_finite()
        && (0.0..=100.0).contains(&point.used_percent)
        && point.queried_at > 0
        && point.queried_at <= now
        && now.saturating_sub(point.queried_at) <= RETENTION_DAYS * 86400
        && !point.bucket_id.is_empty()
        && point.bucket_id.len() <= 160
        && point
            .plan_type
            .as_ref()
            .is_none_or(|plan| plan.len() <= 160)
        && point.window_minutes != Some(0)
}

fn load(path: &Path) -> Result<HistoryFile, &'static str> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HistoryFile {
                version: 1,
                points: vec![],
            })
        }
        Err(_) => return Err(READ_ERROR),
    };
    let mut bytes = vec![];
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| READ_ERROR)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(READ_ERROR);
    }
    let data: HistoryFile = serde_json::from_slice(&bytes).map_err(|_| READ_ERROR)?;
    if data.version != 1 {
        return Err(READ_ERROR);
    }
    Ok(data)
}

fn prune(data: &mut HistoryFile, profiles: &[String], now: u64) {
    data.points
        .retain(|p| profiles.contains(&p.profile_id) && valid(p, now));
    data.points.sort_by_key(|p| p.queried_at);
    let mut counts = std::collections::HashMap::<String, usize>::new();
    data.points.reverse();
    data.points.retain(|p| {
        let count = counts.entry(p.profile_id.clone()).or_default();
        *count += 1;
        *count <= MAX_PROFILE_POINTS
    });
    data.points.truncate(MAX_POINTS);
    data.points.reverse();
}

fn save(path: &Path, data: &HistoryFile) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec(data).map_err(|_| WRITE_ERROR)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(WRITE_ERROR);
    }
    atomic_write(path, &bytes).map_err(|_| WRITE_ERROR)
}

pub fn read(path: &Path, profiles: &[String], now: u64) -> Result<QuotaHistory, &'static str> {
    let mut data = load(path)?;
    let before = data.points.len();
    prune(&mut data, profiles, now);
    if before != data.points.len() {
        save(path, &data)?;
    }
    Ok(QuotaHistory {
        points: data.points,
        retention_days: RETENTION_DAYS,
        max_points: MAX_POINTS,
        max_profile_points: MAX_PROFILE_POINTS,
    })
}

pub fn clear(path: &Path) -> Result<(), &'static str> {
    save(
        path,
        &HistoryFile {
            version: 1,
            points: vec![],
        },
    )
    .map_err(|_| "清空额度变化记录失败")
}

pub fn record(
    path: &Path,
    quota: &AccountQuota,
    profiles: &[String],
    now: u64,
) -> Result<(), &'static str> {
    if !quota.success || !profiles.contains(&quota.profile_id) {
        return Ok(());
    }
    let source = match quota.source.as_deref() {
        Some("appServer") => Source::AppServer,
        Some("compatibility") => Source::Compatibility,
        _ => return Ok(()),
    };
    let mut additions = vec![];
    let mut add = |bucket: &str, kind: WindowKind, window: &Option<UsageWindow>| {
        if let Some(window) = window {
            let point = QuotaPoint {
                profile_id: quota.profile_id.clone(),
                queried_at: quota.queried_at,
                bucket_id: bucket.into(),
                window: kind,
                window_minutes: window.window_minutes,
                used_percent: window.used_percent,
                resets_at: window.resets_at,
                source,
                plan_type: quota.plan_type.clone(),
            };
            if valid(&point, now) {
                additions.push(point);
            }
        }
    };
    if quota.buckets.is_empty() {
        add("codex", WindowKind::Primary, &quota.primary);
        add("codex", WindowKind::Secondary, &quota.secondary);
    } else {
        for bucket in quota.buckets.iter().take(32) {
            add(&bucket.id, WindowKind::Primary, &bucket.primary);
            add(&bucket.id, WindowKind::Secondary, &bucket.secondary);
        }
    }
    let mut data = load(path)?;
    for point in additions {
        // 同秒重复通知只保留一份，避免 IPC / 重试把同一次观测写成两次。
        data.points.retain(|p| {
            !(p.profile_id == point.profile_id
                && p.queried_at == point.queried_at
                && p.bucket_id == point.bucket_id
                && p.window == point.window)
        });
        data.points.push(point);
    }
    prune(&mut data, profiles, now);
    save(path, &data)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn quota() -> AccountQuota {
        AccountQuota {
            profile_id: "p".into(),
            account_id: "never-store-account-id".into(),
            label: "never-store-email".into(),
            primary: Some(UsageWindow {
                used_percent: 12.0,
                window_minutes: Some(300),
                resets_at: Some(8000),
            }),
            secondary: None,
            buckets: vec![],
            reset_credits: None,
            plan_type: Some("plus".into()),
            official_usage: None,
            source: Some("appServer".into()),
            success: true,
            error: None,
            queried_at: 1000,
            history_warning: None,
        }
    }
    #[test]
    fn successful_observations_survive_reload_without_identity_or_secrets() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("history.json");
        let mut q = quota();
        let ids = vec!["p".into()];
        record(&path, &q, &ids, 1000).unwrap();
        record(&path, &q, &ids, 1000).unwrap();
        q.queried_at = 2000;
        q.primary.as_mut().unwrap().used_percent = 26.0;
        record(&path, &q, &ids, 2000).unwrap();
        q.success = false;
        q.error = Some("never-store-error".into());
        record(&path, &q, &ids, 2000).unwrap();
        assert_eq!(read(&path, &ids, 2000).unwrap().points.len(), 2);
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("never-store"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(read(&path, &[], 2000).unwrap().points.is_empty());
    }
    #[test]
    fn malformed_history_is_preserved_until_explicit_clear() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("history.json");
        fs::write(&path, "not json").unwrap();
        assert!(record(&path, &quota(), &["p".into()], 1000).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "not json");
        clear(&path).unwrap();
        assert!(read(&path, &["p".into()], 1000).unwrap().points.is_empty());
    }
    #[test]
    fn retention_bounds_and_invalid_values_are_enforced() {
        let mut p = QuotaPoint {
            profile_id: "p".into(),
            queried_at: 1,
            bucket_id: "codex".into(),
            window: WindowKind::Primary,
            window_minutes: Some(300),
            used_percent: 2.0,
            resets_at: None,
            source: Source::AppServer,
            plan_type: None,
        };
        let now = 4_000_000;
        let mut data = HistoryFile {
            version: 1,
            points: vec![p.clone()],
        };
        for i in 0..2100 {
            p.queried_at = now - i;
            data.points.push(p.clone());
        }
        p.used_percent = f64::NAN;
        data.points.push(p.clone());
        p.used_percent = 101.0;
        data.points.push(p);
        prune(&mut data, &["p".into()], now);
        assert_eq!(data.points.len(), MAX_PROFILE_POINTS);
        assert_eq!(data.points.last().unwrap().queried_at, now);
    }
}
