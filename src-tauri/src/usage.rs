use chrono::{DateTime, Days, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

const HISTORY_DAYS: u64 = 30;
const TREND_DAYS: u64 = 14;
const FILE_SCAN_GRACE_DAYS: u64 = 35;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivationRecord {
    pub account_id: String,
    pub activated_at: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct AccountLabel {
    pub account_id: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBreakdown {
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_write_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
}

impl TokenBreakdown {
    fn add(&mut self, other: Self) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.cached_input_tokens = self
            .cached_input_tokens
            .saturating_add(other.cached_input_tokens);
        self.cache_write_input_tokens = self
            .cache_write_input_tokens
            .saturating_add(other.cache_write_input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.reasoning_output_tokens = self
            .reasoning_output_tokens
            .saturating_add(other.reasoning_output_tokens);
        self.total_tokens = self.total_tokens.saturating_add(other.total_tokens);
    }

    fn saturating_sub(self, previous: Self) -> Self {
        Self {
            input_tokens: self.input_tokens.saturating_sub(previous.input_tokens),
            cached_input_tokens: self
                .cached_input_tokens
                .saturating_sub(previous.cached_input_tokens),
            cache_write_input_tokens: self
                .cache_write_input_tokens
                .saturating_sub(previous.cache_write_input_tokens),
            output_tokens: self.output_tokens.saturating_sub(previous.output_tokens),
            reasoning_output_tokens: self
                .reasoning_output_tokens
                .saturating_sub(previous.reasoning_output_tokens),
            total_tokens: self.total_tokens.saturating_sub(previous.total_tokens),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsage {
    pub date: String,
    pub tokens: TokenBreakdown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountTokenUsage {
    pub account_id: String,
    pub label: String,
    pub tokens: TokenBreakdown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUsageStats {
    pub today: TokenBreakdown,
    pub seven_days: TokenBreakdown,
    pub thirty_days: TokenBreakdown,
    pub daily: Vec<DailyUsage>,
    pub by_account: Vec<AccountTokenUsage>,
    pub unassigned: TokenBreakdown,
    pub files_scanned: u32,
    pub events_count: u32,
    pub generated_at: u64,
}

pub(crate) fn scan_local_usage(
    codex_home: &Path,
    activations: &[ActivationRecord],
    accounts: &[AccountLabel],
) -> LocalUsageStats {
    let today = Local::now().date_naive();
    scan_local_usage_for_date(codex_home, activations, accounts, today)
}

fn scan_local_usage_for_date(
    codex_home: &Path,
    activations: &[ActivationRecord],
    accounts: &[AccountLabel],
    today: NaiveDate,
) -> LocalUsageStats {
    let seven_day_start = today.checked_sub_days(Days::new(6)).unwrap_or(today);
    let thirty_day_start = today
        .checked_sub_days(Days::new(HISTORY_DAYS - 1))
        .unwrap_or(today);
    let trend_start = today
        .checked_sub_days(Days::new(TREND_DAYS - 1))
        .unwrap_or(today);
    let mut daily = BTreeMap::new();
    for offset in (0..TREND_DAYS).rev() {
        if let Some(date) = today.checked_sub_days(Days::new(offset)) {
            daily.insert(date, TokenBreakdown::default());
        }
    }

    let mut sorted_activations = activations.to_vec();
    sorted_activations.sort_by_key(|activation| activation.activated_at);
    let labels = accounts
        .iter()
        .map(|account| (account.account_id.as_str(), account.label.as_str()))
        .collect::<HashMap<_, _>>();
    let mut by_account: HashMap<String, TokenBreakdown> = HashMap::new();
    let mut today_tokens = TokenBreakdown::default();
    let mut seven_days = TokenBreakdown::default();
    let mut thirty_days = TokenBreakdown::default();
    let mut unassigned = TokenBreakdown::default();
    let mut files_scanned = 0u32;
    let mut events_count = 0u32;

    for path in collect_recent_session_files(codex_home) {
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(_) => continue,
        };
        files_scanned = files_scanned.saturating_add(1);
        let mut previous_total: Option<TokenBreakdown> = None;

        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if !line.contains("\"token_count\"") {
                continue;
            }
            let event: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if event.get("type").and_then(Value::as_str) != Some("event_msg")
                || event.pointer("/payload/type").and_then(Value::as_str) != Some("token_count")
            {
                continue;
            }

            let info = match event.pointer("/payload/info") {
                Some(value) if value.is_object() => value,
                _ => continue,
            };
            let current_total = info
                .get("total_token_usage")
                .and_then(parse_token_breakdown);
            let token_delta = info
                .get("last_token_usage")
                .and_then(parse_token_breakdown)
                .or_else(|| {
                    current_total.map(|current| match previous_total {
                        Some(previous) => current.saturating_sub(previous),
                        None => current,
                    })
                });
            if let Some(current) = current_total {
                previous_total = Some(current);
            }
            let Some(token_delta) = token_delta else {
                continue;
            };
            let Some((event_date, event_timestamp)) = parse_event_time(&event) else {
                continue;
            };
            if event_date < thirty_day_start || event_date > today {
                continue;
            }

            events_count = events_count.saturating_add(1);
            thirty_days.add(token_delta);
            if event_date >= seven_day_start {
                seven_days.add(token_delta);
            }
            if event_date == today {
                today_tokens.add(token_delta);
            }
            if event_date >= trend_start {
                if let Some(bucket) = daily.get_mut(&event_date) {
                    bucket.add(token_delta);
                }
            }

            if let Some(account_id) = account_at(&sorted_activations, event_timestamp) {
                by_account
                    .entry(account_id.to_string())
                    .or_default()
                    .add(token_delta);
            } else {
                unassigned.add(token_delta);
            }
        }
    }

    let mut account_usage = by_account
        .into_iter()
        .map(|(account_id, tokens)| AccountTokenUsage {
            label: labels
                .get(account_id.as_str())
                .copied()
                .unwrap_or("已移除账号")
                .to_string(),
            account_id,
            tokens,
        })
        .collect::<Vec<_>>();
    account_usage.sort_by(|left, right| {
        right
            .tokens
            .total_tokens
            .cmp(&left.tokens.total_tokens)
            .then_with(|| left.label.cmp(&right.label))
    });

    LocalUsageStats {
        today: today_tokens,
        seven_days,
        thirty_days,
        daily: daily
            .into_iter()
            .map(|(date, tokens)| DailyUsage {
                date: date.format("%Y-%m-%d").to_string(),
                tokens,
            })
            .collect(),
        by_account: account_usage,
        unassigned,
        files_scanned,
        events_count,
        generated_at: unix_timestamp(),
    }
}

fn parse_token_breakdown(value: &Value) -> Option<TokenBreakdown> {
    if !value.is_object() {
        return None;
    }
    let input_tokens = number(value, "input_tokens");
    let output_tokens = number(value, "output_tokens");
    Some(TokenBreakdown {
        input_tokens,
        cached_input_tokens: number(value, "cached_input_tokens")
            .max(number(value, "cache_read_input_tokens")),
        cache_write_input_tokens: number(value, "cache_write_input_tokens"),
        output_tokens,
        reasoning_output_tokens: number(value, "reasoning_output_tokens"),
        total_tokens: value
            .get("total_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| input_tokens.saturating_add(output_tokens)),
    })
}

fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn parse_event_time(event: &Value) -> Option<(NaiveDate, u64)> {
    let timestamp = event.get("timestamp")?.as_str()?;
    let parsed = DateTime::parse_from_rfc3339(timestamp).ok()?;
    let seconds = parsed.timestamp().try_into().ok()?;
    Some((parsed.with_timezone(&Local).date_naive(), seconds))
}

fn account_at(activations: &[ActivationRecord], timestamp: u64) -> Option<&str> {
    activations
        .iter()
        .rev()
        .find(|activation| activation.activated_at <= timestamp)
        .map(|activation| activation.account_id.as_str())
}

fn collect_recent_session_files(codex_home: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_jsonl_recursive(&codex_home.join("sessions"), &mut files, 0, 3);
    collect_jsonl_recursive(&codex_home.join("archived_sessions"), &mut files, 0, 1);
    files.sort();
    files
}

fn collect_jsonl_recursive(dir: &Path, files: &mut Vec<PathBuf>, depth: u8, max_depth: u8) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let modified_cutoff =
        SystemTime::now().checked_sub(Duration::from_secs(FILE_SCAN_GRACE_DAYS * 24 * 60 * 60));

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() && depth < max_depth {
            collect_jsonl_recursive(&path, files, depth + 1, max_depth);
        } else if file_type.is_file()
            && path.extension().and_then(|extension| extension.to_str()) == Some("jsonl")
        {
            let recent_enough = modified_cutoff.is_none_or(|cutoff| {
                entry
                    .metadata()
                    .ok()
                    .and_then(|metadata| metadata.modified().ok())
                    .is_none_or(|modified| modified >= cutoff)
            });
            if recent_enough {
                files.push(path);
            }
        }
    }
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Local, TimeZone};
    use serde_json::json;
    use std::io::Write;
    use tempfile::TempDir;

    fn write_event(file: &mut File, timestamp: &str, info: Value) {
        writeln!(
            file,
            "{}",
            json!({
                "timestamp": timestamp,
                "type": "event_msg",
                "payload": { "type": "token_count", "info": info }
            })
        )
        .unwrap();
    }

    #[test]
    fn aggregates_last_usage_and_assigns_by_activation() {
        let root = TempDir::new().unwrap();
        let sessions = root.path().join("sessions/2026/08/24");
        fs::create_dir_all(&sessions).unwrap();
        let mut file = File::create(sessions.join("session.jsonl")).unwrap();
        write_event(
            &mut file,
            "2026-08-24T01:00:00Z",
            json!({
                "last_token_usage": {
                    "input_tokens": 120,
                    "cached_input_tokens": 30,
                    "output_tokens": 40,
                    "reasoning_output_tokens": 10,
                    "total_tokens": 160
                },
                "total_token_usage": {
                    "input_tokens": 120,
                    "cached_input_tokens": 30,
                    "output_tokens": 40,
                    "reasoning_output_tokens": 10,
                    "total_tokens": 160
                }
            }),
        );
        write_event(
            &mut file,
            "2026-08-24T02:00:00Z",
            json!({
                "last_token_usage": {
                    "input_tokens": 50,
                    "output_tokens": 20,
                    "total_tokens": 70
                },
                "total_token_usage": {
                    "input_tokens": 170,
                    "cached_input_tokens": 30,
                    "output_tokens": 60,
                    "reasoning_output_tokens": 10,
                    "total_tokens": 230
                }
            }),
        );

        let activation_time = Local
            .with_ymd_and_hms(2026, 8, 24, 0, 30, 0)
            .unwrap()
            .timestamp() as u64;
        let stats = scan_local_usage_for_date(
            root.path(),
            &[ActivationRecord {
                account_id: "account-a".to_string(),
                activated_at: activation_time,
            }],
            &[AccountLabel {
                account_id: "account-a".to_string(),
                label: "个人账号".to_string(),
            }],
            NaiveDate::from_ymd_opt(2026, 8, 24).unwrap(),
        );

        assert_eq!(stats.today.total_tokens, 230);
        assert_eq!(stats.today.cached_input_tokens, 30);
        assert_eq!(stats.by_account[0].tokens.total_tokens, 230);
        assert_eq!(stats.events_count, 2);
    }

    #[test]
    fn falls_back_to_cumulative_deltas_and_keeps_old_events_unassigned() {
        let root = TempDir::new().unwrap();
        let sessions = root.path().join("sessions/2026/08/23");
        fs::create_dir_all(&sessions).unwrap();
        let mut file = File::create(sessions.join("session.jsonl")).unwrap();
        write_event(
            &mut file,
            "2026-08-23T01:00:00Z",
            json!({"total_token_usage": {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120}}),
        );
        write_event(
            &mut file,
            "2026-08-23T02:00:00Z",
            json!({"total_token_usage": {"input_tokens": 140, "output_tokens": 30, "total_tokens": 170}}),
        );

        let stats = scan_local_usage_for_date(
            root.path(),
            &[],
            &[],
            NaiveDate::from_ymd_opt(2026, 8, 24).unwrap(),
        );
        assert_eq!(stats.thirty_days.total_tokens, 170);
        assert_eq!(stats.unassigned.total_tokens, 170);
    }
}
