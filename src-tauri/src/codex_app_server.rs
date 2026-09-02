use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    time::timeout,
};

const QUERY_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug)]
pub enum AppServerError {
    Unavailable,
    QueryFailed,
}

#[derive(Debug)]
pub struct AccountSnapshot {
    pub plan_type: Option<String>,
    pub rate_limits: RateLimitsResponse,
    pub usage: Option<AccountUsageSummary>,
    pub refreshed_auth: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    pub used_percent: f64,
    pub window_duration_mins: Option<u64>,
    pub resets_at: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitSnapshot {
    pub limit_id: Option<String>,
    pub limit_name: Option<String>,
    pub primary: Option<RateLimitWindow>,
    pub secondary: Option<RateLimitWindow>,
    pub plan_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitResetCredit {
    pub status: String,
    pub expires_at: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitResetCredits {
    pub available_count: u64,
    pub credits: Option<Vec<RateLimitResetCredit>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitsResponse {
    pub rate_limits: RateLimitSnapshot,
    pub rate_limits_by_limit_id: Option<HashMap<String, RateLimitSnapshot>>,
    pub rate_limit_reset_credits: Option<RateLimitResetCredits>,
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageSummary {
    pub lifetime_tokens: Option<u64>,
    pub peak_daily_tokens: Option<u64>,
    pub longest_running_turn_sec: Option<u64>,
    pub current_streak_days: Option<u64>,
    pub longest_streak_days: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountUsageResponse {
    summary: AccountUsageSummary,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountResponse {
    account: Option<Account>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Account {
    #[serde(rename = "chatgpt")]
    ChatGpt {
        #[serde(default, rename = "planType")]
        plan_type: Option<String>,
    },
    #[serde(other)]
    Other,
}

pub async fn query_account(auth: &Value) -> Result<AccountSnapshot, AppServerError> {
    let temp_home = tempfile::Builder::new()
        .prefix("codex-auth-switch-")
        .tempdir()
        .map_err(|_| AppServerError::Unavailable)?;
    write_private_json(&temp_home.path().join("auth.json"), auth)
        .map_err(|_| AppServerError::Unavailable)?;

    let mut child = spawn_app_server(temp_home.path())?;
    let mut stdin = child.stdin.take().ok_or(AppServerError::Unavailable)?;
    let stdout = child.stdout.take().ok_or(AppServerError::Unavailable)?;

    for message in [
        json!({
            "method": "initialize",
            "id": 0,
            "params": {
                "clientInfo": {
                    "name": "codex_auth_switch",
                    "title": "Codex Auth Switch",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
        json!({ "method": "initialized", "params": {} }),
        json!({ "method": "account/read", "id": 1, "params": { "refreshToken": false } }),
        json!({ "method": "account/rateLimits/read", "id": 2, "params": {} }),
        json!({ "method": "account/usage/read", "id": 3, "params": {} }),
    ] {
        let mut line = serde_json::to_vec(&message).map_err(|_| AppServerError::QueryFailed)?;
        line.push(b'\n');
        stdin
            .write_all(&line)
            .await
            .map_err(|_| AppServerError::QueryFailed)?;
    }
    stdin
        .flush()
        .await
        .map_err(|_| AppServerError::QueryFailed)?;

    let responses = timeout(QUERY_TIMEOUT, collect_responses(stdout)).await;
    drop(stdin);
    let _ = child.start_kill();
    let _ = child.wait().await;
    let responses = responses.map_err(|_| AppServerError::QueryFailed)??;

    let account: AccountResponse = parse_result(responses.account)?;
    let rate_limits: RateLimitsResponse = parse_result(responses.rate_limits)?;
    let usage = responses
        .usage
        .and_then(|value| parse_result::<AccountUsageResponse>(Some(value)).ok())
        .map(|response| response.summary);
    let plan_type = match account.account {
        Some(Account::ChatGpt { plan_type }) => plan_type,
        _ => None,
    }
    .or_else(|| rate_limits.rate_limits.plan_type.clone());
    let refreshed_auth = read_refreshed_auth(temp_home.path(), auth);

    Ok(AccountSnapshot {
        plan_type,
        rate_limits,
        usage,
        refreshed_auth,
    })
}

struct RpcResponses {
    account: Option<Value>,
    rate_limits: Option<Value>,
    usage: Option<Value>,
}

async fn collect_responses(
    stdout: tokio::process::ChildStdout,
) -> Result<RpcResponses, AppServerError> {
    let mut lines = BufReader::new(stdout).lines();
    let mut responses = RpcResponses {
        account: None,
        rate_limits: None,
        usage: None,
    };
    let mut received = 0;

    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|_| AppServerError::QueryFailed)?
    {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            continue;
        };
        if id == 0 {
            continue;
        }
        if message.get("error").is_some() {
            if id == 3 {
                received += 1;
            } else {
                return Err(AppServerError::QueryFailed);
            }
        } else if let Some(result) = message.get("result").cloned() {
            match id {
                1 => responses.account = Some(result),
                2 => responses.rate_limits = Some(result),
                3 => responses.usage = Some(result),
                _ => continue,
            }
            received += 1;
        }
        if received == 3 {
            return Ok(responses);
        }
    }

    Err(AppServerError::QueryFailed)
}

fn parse_result<T: for<'de> Deserialize<'de>>(value: Option<Value>) -> Result<T, AppServerError> {
    serde_json::from_value(value.ok_or(AppServerError::QueryFailed)?)
        .map_err(|_| AppServerError::QueryFailed)
}

fn spawn_app_server(codex_home: &Path) -> Result<Child, AppServerError> {
    for executable in codex_executables() {
        let mut command = Command::new(executable);
        command
            .args(["app-server", "--listen", "stdio://"])
            .env("CODEX_HOME", codex_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(AppServerError::Unavailable),
        }
    }
    Err(AppServerError::Unavailable)
}

fn codex_executables() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = env::var_os("CODEX_BINARY") {
        paths.push(PathBuf::from(path));
    }
    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from(
            "/Applications/ChatGPT.app/Contents/Resources/codex",
        ));
        paths.push(PathBuf::from(
            "/Applications/Codex.app/Contents/Resources/codex",
        ));
    }
    paths.push(PathBuf::from("codex"));
    paths
}

fn write_private_json(path: &Path, value: &Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(&bytes)?;
    file.sync_all()
}

fn read_refreshed_auth(codex_home: &Path, original: &Value) -> Option<Value> {
    let bytes = fs::read(codex_home.join("auth.json")).ok()?;
    let value = serde_json::from_slice::<Value>(&bytes).ok()?;
    (value != *original).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_current_official_account_shapes() {
        let account: AccountResponse = serde_json::from_value(json!({
            "account": { "type": "chatgpt", "email": "hidden@example.com", "planType": "pro" },
            "requiresOpenaiAuth": true
        }))
        .unwrap();
        assert!(matches!(
            account.account,
            Some(Account::ChatGpt { plan_type }) if plan_type.as_deref() == Some("pro")
        ));

        let limits: RateLimitsResponse = serde_json::from_value(json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": { "usedPercent": 21, "windowDurationMins": 10080, "resetsAt": 1788749509 },
                "planType": "pro"
            },
            "rateLimitsByLimitId": {
                "codex_bengalfox": {
                    "limitId": "codex_bengalfox",
                    "limitName": "GPT-5.3-Codex-Spark",
                    "primary": { "usedPercent": 0, "windowDurationMins": 300, "resetsAt": 1788364857 }
                }
            },
            "rateLimitResetCredits": {
                "availableCount": 1,
                "credits": [{ "status": "available", "expiresAt": 1789978308 }]
            },
            "accountId": "account-test"
        }))
        .unwrap();
        assert_eq!(limits.rate_limits.primary.unwrap().used_percent, 21.0);
        assert_eq!(limits.rate_limits_by_limit_id.unwrap().len(), 1);
        assert_eq!(limits.rate_limit_reset_credits.unwrap().available_count, 1);
        assert_eq!(limits.account_id.as_deref(), Some("account-test"));
    }

    #[test]
    fn parses_optional_official_usage_metrics() {
        let usage: AccountUsageResponse = serde_json::from_value(json!({
            "summary": {
                "lifetimeTokens": 1567980267_u64,
                "peakDailyTokens": 375224027_u64,
                "longestRunningTurnSec": 45622,
                "currentStreakDays": 11,
                "longestStreakDays": 14
            },
            "dailyUsageBuckets": null,
            "threadUsage": null
        }))
        .unwrap();
        assert_eq!(usage.summary.current_streak_days, Some(11));
        assert_eq!(usage.summary.longest_streak_days, Some(14));
    }

    #[cfg(unix)]
    #[test]
    fn writes_probe_auth_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("auth.json");
        write_private_json(&path, &json!({ "auth_mode": "chatgpt" })).unwrap();
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
