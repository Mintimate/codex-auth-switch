use crate::proxy;
use reqwest::StatusCode;
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
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};

const QUERY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub enum AppServerError {
    Unavailable,
    QueryFailed,
    RateLimited,
}

#[derive(Debug)]
pub struct AccountSnapshot {
    pub plan_type: Option<String>,
    pub rate_limits: RateLimitsResponse,
    pub usage: Option<AccountUsage>,
}

// 凭据轮换与额度 RPC 的成败无关，不能让错误分支丢掉临时目录里的新凭据。
pub struct AccountQueryOutcome {
    pub result: Result<AccountSnapshot, AppServerError>,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageDailyBucket {
    pub start_date: String,
    pub tokens: u64,
}

#[derive(Debug, Clone)]
pub struct AccountUsage {
    pub summary: AccountUsageSummary,
    pub daily_usage_buckets: Vec<AccountUsageDailyBucket>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountUsageResponse {
    summary: AccountUsageSummary,
    daily_usage_buckets: Option<Vec<AccountUsageDailyBucket>>,
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

pub async fn query_account(auth: &Value) -> AccountQueryOutcome {
    let temp_home = match tempfile::Builder::new()
        .prefix("codex-auth-switch-")
        .tempdir()
    {
        Ok(home) => home,
        Err(_) => {
            return AccountQueryOutcome {
                result: Err(AppServerError::Unavailable),
                refreshed_auth: None,
            }
        }
    };
    let result = match write_private_json(&temp_home.path().join("auth.json"), auth) {
        Ok(()) => query_account_in_home(temp_home.path()).await,
        Err(_) => Err(AppServerError::Unavailable),
    };
    finish_query(temp_home.path(), auth, result)
}

fn finish_query(
    home: &Path,
    original: &Value,
    result: Result<AccountSnapshot, AppServerError>,
) -> AccountQueryOutcome {
    AccountQueryOutcome {
        result,
        refreshed_auth: read_refreshed_auth(home, original),
    }
}

async fn query_account_in_home(home: &Path) -> Result<AccountSnapshot, AppServerError> {
    let mut child = spawn_app_server(home)?;
    let mut stdin = child.stdin.take().ok_or(AppServerError::Unavailable)?;
    let stdout = child.stdout.take().ok_or(AppServerError::Unavailable)?;

    let mut lines = BufReader::new(stdout).lines();
    let responses = timeout(QUERY_TIMEOUT, async {
        request_rpc(
            &mut stdin,
            &mut lines,
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
            0,
            false,
        )
        .await?;
        write_rpc(
            &mut stdin,
            &json!({ "method": "initialized", "params": {} }),
        )
        .await?;
        let account = request_rpc(
            &mut stdin,
            &mut lines,
            json!({ "method": "account/read", "id": 1, "params": { "refreshToken": false } }),
            1,
            false,
        )
        .await?;
        let rate_limits = request_rpc(
            &mut stdin,
            &mut lines,
            json!({ "method": "account/rateLimits/read", "id": 2, "params": {} }),
            2,
            false,
        )
        .await?;
        let usage = request_rpc(
            &mut stdin,
            &mut lines,
            json!({ "method": "account/usage/read", "id": 3, "params": {} }),
            3,
            true,
        )
        .await?;
        Ok::<_, AppServerError>(RpcResponses {
            account,
            rate_limits,
            usage,
        })
    })
    .await;
    drop(stdin);
    let _ = child.start_kill();
    let _ = child.wait().await;
    let responses = responses.map_err(|_| AppServerError::QueryFailed)??;

    let account: AccountResponse = parse_result(responses.account)?;
    let rate_limits: RateLimitsResponse = parse_result(responses.rate_limits)?;
    let usage = responses
        .usage
        .and_then(|value| parse_result::<AccountUsageResponse>(Some(value)).ok())
        .map(|response| AccountUsage {
            summary: response.summary,
            daily_usage_buckets: response.daily_usage_buckets.unwrap_or_default(),
        });
    let plan_type = match account.account {
        Some(Account::ChatGpt { plan_type }) => plan_type,
        _ => None,
    }
    .or_else(|| rate_limits.rate_limits.plan_type.clone());

    Ok(AccountSnapshot {
        plan_type,
        rate_limits,
        usage,
    })
}

struct RpcResponses {
    account: Option<Value>,
    rate_limits: Option<Value>,
    usage: Option<Value>,
}

async fn read_rpc_result(
    lines: &mut Lines<BufReader<ChildStdout>>,
    expected_id: u64,
    optional: bool,
) -> Result<Option<Value>, AppServerError> {
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
        if id != expected_id {
            continue;
        }
        if let Some(error) = message.get("error") {
            return if optional {
                Ok(None)
            } else {
                Err(classify_rpc_error(error))
            };
        }
        return message
            .get("result")
            .cloned()
            .map(Some)
            .ok_or(AppServerError::QueryFailed);
    }
    Err(AppServerError::QueryFailed)
}

fn classify_rpc_error(error: &Value) -> AppServerError {
    let code_is_rate_limited = error
        .get("code")
        .and_then(Value::as_i64)
        .is_some_and(|code| code == i64::from(StatusCode::TOO_MANY_REQUESTS.as_u16()));
    let message_is_rate_limited = error
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_ascii_lowercase)
        .is_some_and(|message| message.contains("rate limit") || message.contains("http 429"));
    if code_is_rate_limited || message_is_rate_limited {
        AppServerError::RateLimited
    } else {
        AppServerError::QueryFailed
    }
}

async fn write_rpc(stdin: &mut ChildStdin, message: &Value) -> Result<(), AppServerError> {
    let mut line = serde_json::to_vec(message).map_err(|_| AppServerError::QueryFailed)?;
    line.push(b'\n');
    stdin
        .write_all(&line)
        .await
        .map_err(|_| AppServerError::QueryFailed)
}

async fn request_rpc(
    stdin: &mut ChildStdin,
    lines: &mut Lines<BufReader<ChildStdout>>,
    message: Value,
    expected_id: u64,
    optional: bool,
) -> Result<Option<Value>, AppServerError> {
    write_rpc(stdin, &message).await?;
    stdin
        .flush()
        .await
        .map_err(|_| AppServerError::QueryFailed)?;
    read_rpc_result(lines, expected_id, optional).await
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
        apply_proxy_env(&mut command);
        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(AppServerError::Unavailable),
        }
    }
    Err(AppServerError::Unavailable)
}

// codex app-server 通过网络访问官方接口，代理模式需同步到其环境。
// 跟随系统模式保留父进程原有代理变量；无代理与手动模式分别显式移除/注入。
fn apply_proxy_env(command: &mut Command) {
    use proxy::{ChildProxyEnv, PROXY_VARS_FOR_REMOVE};
    match proxy::child_proxy_env() {
        ChildProxyEnv::Inherit => {}
        ChildProxyEnv::Remove => {
            for name in PROXY_VARS_FOR_REMOVE {
                command.env_remove(name);
            }
        }
        ChildProxyEnv::Inject { http_proxy, no_proxy } => {
            command
                .env("HTTP_PROXY", &http_proxy)
                .env("http_proxy", &http_proxy)
                .env("HTTPS_PROXY", &http_proxy)
                .env("https_proxy", &http_proxy)
                .env("ALL_PROXY", &http_proxy)
                .env("all_proxy", &http_proxy);
            if !no_proxy.is_empty() {
                command.env("NO_PROXY", &no_proxy).env("no_proxy", &no_proxy);
            }
        }
    }
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
    fn preserves_rotated_credentials_when_rpc_fails_or_times_out() {
        for error in [AppServerError::RateLimited, AppServerError::QueryFailed] {
            let home = tempfile::TempDir::new().unwrap();
            let original = json!({"tokens":{"refresh_token":"synthetic-original"}});
            let rotated = json!({"tokens":{"refresh_token":"synthetic-rotated"}});
            write_private_json(&home.path().join("auth.json"), &rotated).unwrap();
            let outcome = finish_query(home.path(), &original, Err(error));
            assert!(outcome.result.is_err());
            assert!(outcome.refreshed_auth.as_ref() == Some(&rotated));
        }
    }

    #[test]
    fn failed_query_does_not_invent_a_credential_update() {
        let home = tempfile::TempDir::new().unwrap();
        let auth = json!({"tokens":{"refresh_token":"synthetic-original"}});
        write_private_json(&home.path().join("auth.json"), &auth).unwrap();
        let outcome = finish_query(home.path(), &auth, Err(AppServerError::QueryFailed));
        assert!(outcome.refreshed_auth.is_none());
    }

    #[test]
    fn classifies_rate_limited_rpc_errors() {
        assert!(matches!(
            classify_rpc_error(&json!({ "code": 429, "message": "request failed" })),
            AppServerError::RateLimited
        ));
        assert!(matches!(
            classify_rpc_error(&json!({ "code": -32603, "message": "rate limit exceeded" })),
            AppServerError::RateLimited
        ));
        assert!(matches!(
            classify_rpc_error(&json!({ "code": -32603, "message": "internal error" })),
            AppServerError::QueryFailed
        ));
    }

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
            "dailyUsageBuckets": [
                { "startDate": "2026-08-31", "tokens": 123456_u64 },
                { "startDate": "2026-09-01", "tokens": 789012_u64 }
            ],
            "threadUsage": null
        }))
        .unwrap();
        assert_eq!(usage.summary.current_streak_days, Some(11));
        assert_eq!(usage.summary.longest_streak_days, Some(14));
        let buckets = usage.daily_usage_buckets.unwrap();
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].start_date, "2026-08-31");
        assert_eq!(buckets[1].tokens, 789_012);
    }

    #[test]
    fn accepts_missing_daily_usage_buckets() {
        let usage: AccountUsageResponse = serde_json::from_value(json!({
            "summary": {}
        }))
        .unwrap();
        assert!(usage.daily_usage_buckets.is_none());
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
