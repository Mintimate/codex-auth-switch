//! 可序列化的额度领域模型，不含认证凭据或存储实现。
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub used_percent: f64,
    pub window_minutes: Option<u64>,
    pub resets_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageResetCredits {
    pub available_count: u64,
    pub expires_at: Vec<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaBucket {
    pub id: String,
    pub name: Option<String>,
    pub primary: Option<UsageWindow>,
    pub secondary: Option<UsageWindow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageSummary {
    pub lifetime_tokens: Option<u64>,
    pub peak_daily_tokens: Option<u64>,
    pub longest_running_turn_sec: Option<u64>,
    pub current_streak_days: Option<u64>,
    pub longest_streak_days: Option<u64>,
    pub daily_usage_buckets: Vec<AccountUsageDailyBucket>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageDailyBucket {
    pub start_date: String,
    pub tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountQuota {
    pub profile_id: String,
    pub account_id: String,
    pub label: String,
    pub primary: Option<UsageWindow>,
    pub secondary: Option<UsageWindow>,
    pub buckets: Vec<QuotaBucket>,
    pub reset_credits: Option<UsageResetCredits>,
    pub plan_type: Option<String>,
    pub official_usage: Option<AccountUsageSummary>,
    pub source: Option<String>,
    pub success: bool,
    pub error: Option<String>,
    pub queried_at: u64,
    pub history_warning: Option<String>,
}
