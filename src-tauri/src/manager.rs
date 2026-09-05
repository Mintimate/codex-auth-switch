use crate::{
    auth_share::{self, ImportedAuth},
    codex_app_server,
    proxy,
    query_gate::{QueryGate, QueryPermit},
    usage::{
        provider_label, scan_local_usage_cached, AccountLabel, ActivationRecord, LocalUsageStats,
        ModelProviderKind, ModelProviderOption, ModelProviderState, ProviderCatalog,
    },
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use futures_util::{stream, Stream, StreamExt};
use reqwest::{header::RETRY_AFTER, Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fmt, fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::Mutex, time::sleep};
use toml_edit::{value as toml_edit_value, DocumentMut};

const VAULT_VERSION: u32 = 1;
const VAULT_FILE_NAME: &str = "accounts.v1.json";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_AUTH_USERCODE_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_AUTH_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
const OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDITS_URL: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const DEVICE_VERIFICATION_URL: &str = "https://auth.openai.com/codex/device";
const DEVICE_REDIRECT_URI: &str = "https://auth.openai.com/deviceauth/callback";
const DEVICE_CODE_DEFAULT_EXPIRES_IN: u64 = 900;
const POLLING_SAFETY_MARGIN_SECS: u64 = 3;
const USER_AGENT: &str = "codex-auth-switch";
const OAUTH_QUERY_TIMEOUT_SECS: u64 = 45;
const USAGE_QUERY_TIMEOUT_SECS: u64 = 10;
const QUOTA_RETRY_BASE_DELAY_MS: u64 = 400;
const QUOTA_RETRY_MAX_DELAY_SECS: u64 = 5;
const MAX_ACTIVATION_RECORDS: usize = 10_000;
const MAX_CONCURRENT_QUOTA_QUERIES: usize = 2;
const ONE_MILLION_CONTEXT_WINDOW: i64 = 1_000_000;
const ONE_MILLION_AUTO_COMPACT_LIMIT: i64 = 900_000;
const CREDENTIAL_STORAGE_VALUES: &[&str] = &["file", "keyring", "auto"];
const REASONING_EFFORT_VALUES: &[&str] = &["minimal", "low", "medium", "high", "xhigh"];
const REASONING_SUMMARY_VALUES: &[&str] = &["auto", "concise", "detailed", "none"];
const MODEL_VERBOSITY_VALUES: &[&str] = &["low", "medium", "high"];
const WEB_SEARCH_VALUES: &[&str] = &["disabled", "cached", "indexed", "live"];

// 登录服务与额度查询使用不同超时：令牌交换允许更长等待，但不能无限占用操作锁。
// reqwest 客户端带连接池，复用才能保住连接；代理设置可能变化，因此由 proxy 模块
// 按 (设置, 超时) 缓存，设备登录轮询（每 5-8 秒）会复用同一客户端。

#[derive(Debug)]
pub enum ManagerError {
    Io(String),
    InvalidConfig(String),
    UnsupportedStorage(String),
    InvalidAuth(String),
    ProfileNotFound,
    Network(String),
    DeviceCodeExpired,
    DeviceLoginCancelled,
    TokenExchange(String),
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexContextMode {
    Default,
    OneMillion,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexConfigKey {
    CredentialStorage,
    ReasoningEffort,
    ReasoningSummary,
    ModelVerbosity,
    WebSearch,
}

impl CodexConfigKey {
    fn definition(self) -> (&'static str, &'static [&'static str]) {
        match self {
            Self::CredentialStorage => ("cli_auth_credentials_store", CREDENTIAL_STORAGE_VALUES),
            Self::ReasoningEffort => ("model_reasoning_effort", REASONING_EFFORT_VALUES),
            Self::ReasoningSummary => ("model_reasoning_summary", REASONING_SUMMARY_VALUES),
            Self::ModelVerbosity => ("model_verbosity", MODEL_VERBOSITY_VALUES),
            Self::WebSearch => ("web_search", WEB_SEARCH_VALUES),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexContextConfig {
    mode: String,
    context_window: Option<i64>,
    auto_compact_token_limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexChoiceConfig {
    value: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexManagedConfig {
    credential_storage: CodexChoiceConfig,
    context: CodexContextConfig,
    reasoning_effort: CodexChoiceConfig,
    reasoning_summary: CodexChoiceConfig,
    model_verbosity: CodexChoiceConfig,
    web_search: CodexChoiceConfig,
}

impl fmt::Display for ManagerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(message)
            | Self::InvalidConfig(message)
            | Self::InvalidAuth(message)
            | Self::Network(message)
            | Self::TokenExchange(message) => formatter.write_str(message),
            Self::UnsupportedStorage(mode) => write!(
                formatter,
                "当前 Codex 凭据存储模式为 {mode}；请先在 config.toml 中设置 cli_auth_credentials_store = \"file\""
            ),
            Self::ProfileNotFound => formatter.write_str("找不到指定账号"),
            Self::DeviceLoginCancelled => formatter.write_str("登录已取消，请重新发起登录"),
            Self::DeviceCodeExpired => {
                formatter.write_str("登录验证码已过期，请重新发起登录")
            }
        }
    }
}

impl std::error::Error for ManagerError {}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub id: String,
    pub label: String,
    pub account_id: String,
    pub email: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub codex_home: String,
    pub vault_path: String,
    pub storage_mode: String,
    pub supported: bool,
    pub active_account_id: Option<String>,
    pub accounts: Vec<AccountSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLoginResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

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
}

pub struct PreparedAuthTransfer {
    pub text: String,
    pub qr_data_url: Option<String>,
    pub qr_error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_auth_id: String,
    user_code: String,
    #[serde(default)]
    interval: Option<Value>,
    #[serde(default)]
    expires_in: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct DevicePollSuccess {
    authorization_code: String,
    code_verifier: String,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexRateLimitWindow {
    used_percent: Option<f64>,
    limit_window_seconds: Option<u64>,
    reset_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct CodexRateLimit {
    primary_window: Option<CodexRateLimitWindow>,
    secondary_window: Option<CodexRateLimitWindow>,
}

#[derive(Debug, Deserialize)]
struct CodexResetCreditsSummary {
    available_count: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct CodexUsageResponse {
    rate_limit: Option<CodexRateLimit>,
    rate_limit_reset_credits: Option<CodexResetCreditsSummary>,
}

#[derive(Debug, Deserialize)]
struct CodexResetCredit {
    status: Option<String>,
    is_supported_by_plan: Option<bool>,
    expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexResetCreditsResponse {
    #[serde(default)]
    credits: Vec<CodexResetCredit>,
    available_count: Option<u64>,
}

enum QuotaQueryError {
    Unauthorized,
    Message(String),
}

struct QuotaDetails {
    primary: Option<UsageWindow>,
    secondary: Option<UsageWindow>,
    buckets: Vec<QuotaBucket>,
    reset_credits: Option<UsageResetCredits>,
    plan_type: Option<String>,
    official_usage: Option<AccountUsageSummary>,
    source: String,
}

type QuotaQueryResult = Result<QuotaDetails, QuotaQueryError>;

// 并发查询阶段不碰 vault，只把结果和「需要回写的刷新令牌」带回串行阶段统一落盘。
struct QuotaOutcome {
    query_permit: Option<QueryPermit>,
    profile_id: String,
    account_id: String,
    original_auth: Value,
    queried_at: u64,
    result: QuotaQueryResult,
    refreshed_auth: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProfileRecord {
    id: String,
    label: String,
    account_id: String,
    email: Option<String>,
    auth: Value,
    created_at: u64,
    updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Vault {
    version: u32,
    profiles: Vec<ProfileRecord>,
    #[serde(default)]
    activations: Vec<ActivationRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_activation: Option<ActivationRecord>,
    // 早期版本记录过计费来源时间线，现已改为按会话读 model_provider。
    // 保留字段以免旧账号库反序列化失败，但不再读写。
    #[allow(dead_code)]
    #[serde(default, skip_serializing)]
    legacy_sources: Vec<LegacySourceRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LegacySourceRecord {
    #[serde(default)]
    source_id: String,
    #[serde(default)]
    marked_at: u64,
}

impl Default for Vault {
    fn default() -> Self {
        Self {
            version: VAULT_VERSION,
            profiles: Vec::new(),
            activations: Vec::new(),
            pending_activation: None,
            legacy_sources: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AuthIdentity {
    pub(crate) account_id: String,
    pub(crate) email: Option<String>,
}

#[derive(Debug)]
struct TransferSeed {
    label: Option<String>,
    id_token: String,
    refresh_token: String,
    account_id: String,
}

#[derive(Debug, Default, Deserialize)]
struct TokenClaims {
    #[serde(default)]
    chatgpt_account_id: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    organizations: Vec<OrganizationClaim>,
    #[serde(default, rename = "https://api.openai.com/auth")]
    openai_auth: Option<OpenAiAuthClaim>,
}

#[derive(Debug, Default, Deserialize)]
struct OrganizationClaim {
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct OpenAiAuthClaim {
    #[serde(default)]
    chatgpt_account_id: Option<String>,
}

#[derive(Clone)]
pub struct AccountManager {
    codex_home: PathBuf,
    vault_path: PathBuf,
}

impl AccountManager {
    pub fn from_environment(app_data_dir: PathBuf) -> Result<Self, ManagerError> {
        let codex_home = match env::var_os("CODEX_HOME") {
            Some(path) => PathBuf::from(path),
            None => dirs::home_dir()
                .ok_or_else(|| ManagerError::Io("无法定位用户主目录".to_string()))?
                .join(".codex"),
        };
        Ok(Self::new(codex_home, app_data_dir))
    }

    pub fn new(codex_home: PathBuf, app_data_dir: PathBuf) -> Self {
        Self {
            codex_home,
            vault_path: app_data_dir.join(VAULT_FILE_NAME),
        }
    }

    pub(crate) fn codex_home_path(&self) -> &Path {
        &self.codex_home
    }

    pub(crate) fn vault_path(&self) -> &Path {
        &self.vault_path
    }

    pub fn status(&self) -> Result<AppStatus, ManagerError> {
        let storage_mode = self.storage_mode()?;
        let supported = storage_mode == "file";
        let active_identity = if supported {
            self.read_live_auth()
                .ok()
                .and_then(|auth| validate_chatgpt_auth(&auth).ok())
        } else {
            None
        };
        let active_account_id = active_identity.map(|identity| identity.account_id);
        let mut accounts = self
            .load_vault()?
            .profiles
            .into_iter()
            .map(|profile| AccountSummary {
                active: active_account_id.as_deref() == Some(profile.account_id.as_str()),
                id: profile.id,
                label: profile.label,
                account_id: profile.account_id,
                email: profile.email,
                created_at: profile.created_at,
                updated_at: profile.updated_at,
            })
            .collect::<Vec<_>>();
        accounts.sort_by(|left, right| {
            right
                .active
                .cmp(&left.active)
                .then_with(|| left.label.to_lowercase().cmp(&right.label.to_lowercase()))
        });

        Ok(AppStatus {
            codex_home: self.codex_home.display().to_string(),
            vault_path: self.vault_path.display().to_string(),
            storage_mode,
            supported,
            active_account_id,
            accounts,
        })
    }

    pub fn save_current(&self, label: &str) -> Result<AppStatus, ManagerError> {
        self.ensure_file_storage()?;
        let label = validate_label(label)?;
        let auth = self.read_live_auth()?;
        let identity = validate_chatgpt_auth(&auth)?;
        let mut vault = self.load_vault()?;
        upsert_profile(&mut vault, auth, Some(label))?;
        record_activation(&mut vault, &identity.account_id, unix_timestamp());
        self.save_vault(&vault)?;
        self.status()
    }

    pub fn switch_account(&self, profile_id: &str) -> Result<AppStatus, ManagerError> {
        self.ensure_file_storage()?;
        let mut vault = self.load_vault()?;

        if let Ok(current_auth) = self.read_live_auth() {
            if validate_chatgpt_auth(&current_auth).is_ok() {
                refresh_saved_profile(&mut vault, current_auth)?;
            }
        }

        let target = vault
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .cloned()
            .ok_or(ManagerError::ProfileNotFound)?;

        self.commit_activation(&mut vault, &target.auth)?;
        self.status()
    }

    pub fn rename_account(&self, profile_id: &str, label: &str) -> Result<AppStatus, ManagerError> {
        let label = validate_label(label)?;
        let mut vault = self.load_vault()?;
        let profile = vault
            .profiles
            .iter_mut()
            .find(|profile| profile.id == profile_id)
            .ok_or(ManagerError::ProfileNotFound)?;
        profile.label = label.to_string();
        profile.updated_at = unix_timestamp();
        self.save_vault(&vault)?;
        self.status()
    }

    pub fn remove_account(&self, profile_id: &str) -> Result<AppStatus, ManagerError> {
        let mut vault = self.load_vault()?;
        if !vault
            .profiles
            .iter()
            .any(|profile| profile.id == profile_id)
        {
            return Err(ManagerError::ProfileNotFound);
        }
        vault.profiles.retain(|profile| profile.id != profile_id);
        self.save_vault(&vault)?;
        self.status()
    }

    pub async fn prepare_auth_transfer(
        &self,
        profile_id: &str,
    ) -> Result<PreparedAuthTransfer, ManagerError> {
        let (_, auth) = self.auth_transfer_source(profile_id)?;
        let refreshed_auth = refresh_codex_auth(&auth).await?;
        let (_, refreshed_auth) = self.persist_refreshed_transfer(profile_id, refreshed_auth)?;
        let text = auth_share::encode_text(&refreshed_auth)
            .map_err(|error| ManagerError::InvalidAuth(error.to_string()))?;
        let qr_result = auth_share::encode_qr_payload(&refreshed_auth)
            .and_then(|payload| auth_share::render_qr_data_url(&payload));
        let (qr_data_url, qr_error) = match qr_result {
            Ok(qr_data_url) => (Some(qr_data_url), None),
            Err(error) => (None, Some(error.to_string())),
        };
        Ok(PreparedAuthTransfer {
            text,
            qr_data_url,
            qr_error,
        })
    }

    fn auth_transfer_source(&self, profile_id: &str) -> Result<(String, Value), ManagerError> {
        self.ensure_file_storage()?;
        let mut vault = self.load_vault()?;
        if let Ok(current_auth) = self.read_live_auth() {
            if validate_chatgpt_auth(&current_auth).is_ok() {
                refresh_saved_profile(&mut vault, current_auth)?;
                self.save_vault(&vault)?;
            }
        }
        let profile = vault
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or(ManagerError::ProfileNotFound)?;
        let auth = canonical_chatgpt_auth(&profile.auth)?;
        Ok((profile.label.clone(), auth))
    }

    fn persist_refreshed_transfer(
        &self,
        profile_id: &str,
        refreshed_auth: Value,
    ) -> Result<(String, Value), ManagerError> {
        let refreshed_auth = canonical_chatgpt_auth(&refreshed_auth)?;
        let identity = validate_chatgpt_auth(&refreshed_auth)?;
        let mut vault = self.load_vault()?;
        let profile = vault
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or(ManagerError::ProfileNotFound)?;
        if profile.account_id != identity.account_id {
            return Err(ManagerError::InvalidAuth(
                "刷新后的凭据与待迁移账号不一致，请重新登录".to_string(),
            ));
        }
        let label = profile.label.clone();

        let selected_account_is_active = self
            .read_live_auth()
            .ok()
            .and_then(|auth| validate_chatgpt_auth(&auth).ok())
            .is_some_and(|active| active.account_id == identity.account_id);
        if selected_account_is_active {
            // refresh_token 已经轮换时，优先更新 Codex 正在读取的缓存，避免它继续使用旧值。
            self.write_live_auth(&refreshed_auth)?;
        }
        upsert_profile(&mut vault, refreshed_auth.clone(), None)?;
        self.save_vault(&vault)?;
        Ok((label, refreshed_auth))
    }

    pub async fn import_auth_share_text(&self, text: &str) -> Result<AppStatus, ManagerError> {
        let imported = auth_share::decode_text(text)
            .map_err(|error| ManagerError::InvalidAuth(error.to_string()))?;
        self.import_shared_auth(imported).await
    }

    pub async fn import_auth_share_qr(&self, image: &str) -> Result<AppStatus, ManagerError> {
        let imported = auth_share::decode_qr_image_base64(image)
            .map_err(|error| ManagerError::InvalidAuth(error.to_string()))?;
        self.import_shared_auth(imported).await
    }

    async fn import_shared_auth(&self, imported: ImportedAuth) -> Result<AppStatus, ManagerError> {
        self.ensure_file_storage()?;
        let seed = transfer_seed(imported)?;
        let refreshed = exchange_refresh_token(
            &seed.refresh_token,
            "迁移内容可能已被使用或已失效，请在发送端重新生成",
        )
        .await?;
        let auth = materialize_transferred_auth(seed.id_token, seed.account_id, refreshed)?;
        self.import_materialized_auth(auth, seed.label.as_deref())
    }

    fn import_materialized_auth(
        &self,
        auth: Value,
        label: Option<&str>,
    ) -> Result<AppStatus, ManagerError> {
        let auth = canonical_chatgpt_auth(&auth)?;
        let identity = validate_chatgpt_auth(&auth)?;
        let mut vault = self.load_vault()?;

        if let Ok(current_auth) = self.read_live_auth() {
            if validate_chatgpt_auth(&current_auth).is_ok() {
                refresh_saved_profile(&mut vault, current_auth)?;
            }
        }
        let already_saved = vault
            .profiles
            .iter()
            .any(|profile| profile.account_id == identity.account_id);
        upsert_profile(
            &mut vault,
            auth.clone(),
            (!already_saved).then_some(label).flatten(),
        )?;
        self.commit_activation(&mut vault, &auth)?;
        self.status()
    }

    pub async fn start_device_login(
        &self,
        label: &str,
    ) -> Result<DeviceLoginResponse, ManagerError> {
        self.ensure_file_storage()?;
        validate_label(label)?;

        let response = oauth_client()?
            .post(DEVICE_AUTH_USERCODE_URL)
            .json(&serde_json::json!({ "client_id": CODEX_CLIENT_ID }))
            .send()
            .await
            .map_err(|error| network_error("申请登录验证码", error))?;

        if !response.status().is_success() {
            return Err(ManagerError::Network(format!(
                "申请登录验证码失败（HTTP {}），请稍后重试",
                response.status()
            )));
        }

        let device: DeviceCodeResponse = response
            .json()
            .await
            .map_err(|_| ManagerError::Network("登录服务返回了无法识别的设备码响应".to_string()))?;
        if device.device_auth_id.trim().is_empty() || device.user_code.trim().is_empty() {
            return Err(ManagerError::Network(
                "登录服务返回的设备码不完整".to_string(),
            ));
        }

        Ok(DeviceLoginResponse {
            device_code: device.device_auth_id,
            user_code: device.user_code,
            verification_uri: DEVICE_VERIFICATION_URL.to_string(),
            expires_in: device.expires_in.unwrap_or(DEVICE_CODE_DEFAULT_EXPIRES_IN),
            interval: parse_interval(device.interval.as_ref()),
        })
    }

    // 网络阶段只产生后端凭据，提交前由登录会话检查取消与过期状态。
    pub(crate) async fn poll_device_auth(
        &self,
        device_code: &str,
        user_code: &str,
    ) -> Result<Option<Value>, ManagerError> {
        self.ensure_file_storage()?;
        if device_code.trim().is_empty() || user_code.trim().is_empty() {
            return Err(ManagerError::InvalidConfig(
                "登录验证码状态无效，请重新发起登录".to_string(),
            ));
        }

        let response = oauth_client()?
            .post(DEVICE_AUTH_TOKEN_URL)
            .json(&serde_json::json!({
                "device_auth_id": device_code,
                "user_code": user_code,
            }))
            .send()
            .await
            .map_err(|error| network_error("检查登录状态", error))?;

        match response.status() {
            StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => return Ok(None),
            StatusCode::GONE => return Err(ManagerError::DeviceCodeExpired),
            status if !status.is_success() => {
                return Err(ManagerError::Network(format!(
                    "检查登录状态失败（HTTP {status}），请稍后重试"
                )))
            }
            _ => {}
        }

        let success: DevicePollSuccess = response
            .json()
            .await
            .map_err(|_| ManagerError::Network("登录服务返回了无法识别的授权响应".to_string()))?;
        let tokens =
            exchange_code_for_tokens(&success.authorization_code, &success.code_verifier).await?;
        let auth = materialize_codex_auth(tokens)?;
        validate_chatgpt_auth(&auth)?;

        Ok(Some(auth))
    }

    pub(crate) fn complete_device_login(
        &self,
        auth: Value,
        label: &str,
    ) -> Result<AppStatus, ManagerError> {
        self.ensure_file_storage()?;
        let label = validate_label(label)?;
        let auth = canonical_chatgpt_auth(&auth)?;
        let mut vault = self.load_vault()?;
        if let Ok(current_auth) = self.read_live_auth() {
            refresh_saved_profile(&mut vault, current_auth)?;
        }
        upsert_profile(&mut vault, auth.clone(), Some(label))?;
        self.commit_activation(&mut vault, &auth)?;
        self.status()
    }

    // 先保存新凭据与待完成记录，再替换认证。激活历史只描述已完成的切换。
    // 若在替换后中断，下次读取根据实际 auth.json 恢复历史，无需回滚已轮换凭据。
    fn commit_activation(&self, vault: &mut Vault, auth: &Value) -> Result<(), ManagerError> {
        let identity = validate_chatgpt_auth(auth)?;
        let activated_at = unix_timestamp();
        vault.pending_activation = Some(ActivationRecord {
            account_id: identity.account_id.clone(),
            activated_at,
        });
        self.save_vault(vault)?;
        self.write_live_auth(auth)?;
        record_activation(vault, &identity.account_id, activated_at);
        vault.pending_activation = None;
        self.save_vault(vault)
    }

    pub async fn account_quotas(
        &self,
        operation_gate: &Mutex<()>,
        query_gate: &QueryGate,
    ) -> Result<Vec<AccountQuota>, ManagerError> {
        self.account_quotas_with_updates(operation_gate, query_gate, None, |_| {})
            .await
    }

    pub async fn account_quotas_with_updates(
        &self,
        operation_gate: &Mutex<()>,
        query_gate: &QueryGate,
        profile_ids: Option<&[String]>,
        on_update: impl Fn(AccountQuota),
    ) -> Result<Vec<AccountQuota>, ManagerError> {
        self.ensure_file_storage()?;
        // 锁内只读取账号快照。远端查询不占用全局操作锁，账号切换和登录轮询无需等待整批查询。
        let quota_targets = {
            let _guard = operation_gate.lock().await;
            self.quota_targets(profile_ids)?
        };

        let outcomes = stream::iter(quota_targets.into_iter().map(
            |(profile_id, _, _)| async move {
                let permit = query_gate.acquire(&profile_id).await;
                // 等待同账号查询期间凭据可能已轮换，拿到锁后重新取最新快照。
                let (_, account_id, auth) = {
                    let _guard = operation_gate.lock().await;
                    self.quota_targets(Some(&[profile_id.clone()]))?
                        .pop()
                        .ok_or(ManagerError::ProfileNotFound)?
                };
                let queried_at = unix_timestamp();
                let (result, refreshed_auth) = query_account_details(&auth, &account_id).await;
                Ok(QuotaOutcome {
                    query_permit: Some(permit),
                    profile_id,
                    account_id,
                    original_auth: auth,
                    queried_at,
                    result,
                    refreshed_auth,
                })
            },
        ))
        .buffer_unordered(MAX_CONCURRENT_QUOTA_QUERIES);
        self.collect_quota_outcomes(outcomes, operation_gate, on_update)
            .await
    }

    fn quota_targets(
        &self,
        profile_ids: Option<&[String]>,
    ) -> Result<Vec<(String, String, Value)>, ManagerError> {
        let (vault, _) = self.load_usage_vault()?;
        if profile_ids.is_some_and(|ids| {
            ids.iter()
                .any(|id| !vault.profiles.iter().any(|profile| &profile.id == id))
        }) {
            return Err(ManagerError::ProfileNotFound);
        }
        Ok(vault
            .profiles
            .into_iter()
            .filter(|profile| profile_ids.is_none_or(|ids| ids.contains(&profile.id)))
            .map(|profile| (profile.id, profile.account_id, profile.auth))
            .collect::<Vec<_>>())
    }

    async fn collect_quota_outcomes(
        &self,
        outcomes: impl Stream<Item = Result<QuotaOutcome, ManagerError>>,
        operation_gate: &Mutex<()>,
        on_update: impl Fn(AccountQuota),
    ) -> Result<Vec<AccountQuota>, ManagerError> {
        futures_util::pin_mut!(outcomes);
        let mut quotas = Vec::new();
        let mut first_error = None;
        while let Some(outcome) = outcomes.next().await {
            // 每个账号完成就持久化；即使某次写入失败也继续收取其他已发出的刷新结果。
            let _guard = operation_gate.lock().await;
            match outcome.and_then(|outcome| self.merge_quota_outcome(outcome)) {
                Ok(Some(quota)) => {
                    on_update(quota.clone());
                    quotas.push(quota);
                }
                Ok(None) => {}
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        Ok(quotas)
    }

    fn merge_quota_outcome(
        &self,
        outcome: QuotaOutcome,
    ) -> Result<Option<AccountQuota>, ManagerError> {
        // 查询期间可能发生切换或移除，按稳定 ID 和原始凭据合并最新账号库。
        let mut vault = self.load_vault()?;
        let live_auth = self.read_live_auth().ok();
        let active_account_id = live_auth
            .as_ref()
            .and_then(|auth| validate_chatgpt_auth(auth).ok())
            .map(|identity| identity.account_id);
        let QuotaOutcome {
            query_permit: _query_permit,
            profile_id,
            account_id,
            original_auth,
            queried_at,
            result,
            refreshed_auth,
        } = outcome;
        if let Some(auth) = refreshed_auth.as_ref() {
            let vault_changed = self.persist_refreshed_quota_auth(
                &mut vault,
                &account_id,
                &original_auth,
                auth,
                live_auth.as_ref(),
                active_account_id.as_deref(),
            )?;
            if vault_changed {
                self.save_vault(&vault)?;
            }
        }

        let Some(profile_index) = vault
            .profiles
            .iter()
            .position(|profile| profile.id == profile_id && profile.account_id == account_id)
        else {
            return Ok(None);
        };

        let profile = &vault.profiles[profile_index];
        let quota = match result {
            Ok(details) => AccountQuota {
                profile_id: profile.id.clone(),
                account_id: profile.account_id.clone(),
                label: profile.label.clone(),
                primary: details.primary,
                secondary: details.secondary,
                buckets: details.buckets,
                reset_credits: details.reset_credits,
                plan_type: details.plan_type,
                official_usage: details.official_usage,
                source: Some(details.source),
                success: true,
                error: None,
                queried_at,
            },
            Err(QuotaQueryError::Unauthorized) => AccountQuota {
                profile_id: profile.id.clone(),
                account_id: profile.account_id.clone(),
                label: profile.label.clone(),
                primary: None,
                secondary: None,
                buckets: Vec::new(),
                reset_credits: None,
                plan_type: None,
                official_usage: None,
                source: None,
                success: false,
                error: Some("订阅凭据已失效，请重新登录该账号".to_string()),
                queried_at,
            },
            Err(QuotaQueryError::Message(message)) => AccountQuota {
                profile_id: profile.id.clone(),
                account_id: profile.account_id.clone(),
                label: profile.label.clone(),
                primary: None,
                secondary: None,
                buckets: Vec::new(),
                reset_credits: None,
                plan_type: None,
                official_usage: None,
                source: None,
                success: false,
                error: Some(message),
                queried_at,
            },
        };
        Ok(Some(quota))
    }

    fn persist_refreshed_quota_auth(
        &self,
        vault: &mut Vault,
        account_id: &str,
        original_auth: &Value,
        refreshed_auth: &Value,
        live_auth: Option<&Value>,
        active_account_id: Option<&str>,
    ) -> Result<bool, ManagerError> {
        let active_is_target = active_account_id == Some(account_id);
        let active_auth_unchanged = !active_is_target || live_auth == Some(original_auth);
        if !active_auth_unchanged {
            return Ok(false);
        }

        if active_is_target {
            // 当前账号即使已从本地账号库移除，Codex 仍会继续使用 auth.json。
            self.write_live_auth(refreshed_auth)?;
        }

        let Some(profile) = vault
            .profiles
            .iter_mut()
            .find(|profile| profile.account_id == account_id && profile.auth == *original_auth)
        else {
            return Ok(false);
        };
        profile.auth = refreshed_auth.clone();
        profile.updated_at = unix_timestamp();
        Ok(true)
    }

    pub async fn local_usage(
        &self,
        operation_gate: &Mutex<()>,
    ) -> Result<LocalUsageStats, ManagerError> {
        let vault = {
            let _guard = operation_gate.lock().await;
            // 会话统计不依赖当前凭据，也不能因账号库损坏而阻止读取计数。
            let mut vault = read_json::<Vault>(&self.vault_path, "本地账号库")
                .ok()
                .filter(|vault| vault.version == VAULT_VERSION)
                .unwrap_or_default();
            if self.storage_mode().ok().as_deref() == Some("file") {
                self.recover_pending_activation(&mut vault);
            }
            vault
        };
        let accounts = vault
            .profiles
            .iter()
            .map(|profile| AccountLabel {
                account_id: profile.account_id.clone(),
                label: profile.label.clone(),
            })
            .collect::<Vec<_>>();
        // 扫描会遍历整个 sessions 目录并逐行解析 JSONL，必须让出 async 工作线程，
        // 否则会话文件多时会把 tokio 的 worker 全部占满。
        let codex_home = self.codex_home.clone();
        let activations = vault.activations.clone();
        let catalog = self.provider_catalog();
        let cache_path = self.usage_cache_path();
        tauri::async_runtime::spawn_blocking(move || {
            scan_local_usage_cached(&codex_home, &cache_path, &activations, &accounts, &catalog)
        })
        .await
        .map_err(|error| ManagerError::Io(format!("读取本地会话用量失败: {error}")))
    }

    pub(crate) fn usage_cache_path(&self) -> PathBuf {
        self.vault_path
            .with_file_name(crate::usage::USAGE_CACHE_FILE)
    }

    fn load_usage_vault(&self) -> Result<(Vault, Option<String>), ManagerError> {
        self.ensure_file_storage()?;
        let mut vault = self.load_vault()?;
        let mut vault_changed = false;
        let active_account_id = if let Ok(auth) = self.read_live_auth() {
            if let Ok(identity) = validate_chatgpt_auth(&auth) {
                vault_changed |= refresh_saved_profile(&mut vault, auth)?;
                Some(identity.account_id)
            } else {
                None
            }
        } else {
            None
        };
        if let Some(account_id) = active_account_id.as_deref() {
            vault_changed |= record_activation(&mut vault, account_id, unix_timestamp());
        }
        if vault_changed {
            self.save_vault(&vault)?;
        }
        Ok((vault, active_account_id))
    }

    fn auth_path(&self) -> PathBuf {
        self.codex_home.join("auth.json")
    }

    fn config_path(&self) -> PathBuf {
        self.codex_home.join("config.toml")
    }

    fn read_config_document(&self) -> Result<DocumentMut, ManagerError> {
        let config_path = self.config_path();
        recover_legacy_backup(&config_path)?;
        let contents = if config_path.exists() {
            fs::read_to_string(&config_path).map_err(|error| {
                ManagerError::Io(format!("读取 {} 失败: {error}", config_path.display()))
            })?
        } else {
            String::new()
        };
        contents.parse::<DocumentMut>().map_err(|_| {
            // TOML 错误的 Display 会附带源文件内容，其中可能包含凭据。
            ManagerError::InvalidConfig("Codex config.toml 格式错误，请检查配置语法".to_string())
        })
    }

    fn write_config_document(&self, document: &DocumentMut) -> Result<(), ManagerError> {
        atomic_write(&self.config_path(), document.to_string().as_bytes())
    }

    pub fn codex_managed_config(&self) -> Result<CodexManagedConfig, ManagerError> {
        let document = self.read_config_document()?;
        Ok(managed_config_from_document(&document))
    }

    pub fn set_codex_config_choice(
        &self,
        key: CodexConfigKey,
        next_value: &str,
    ) -> Result<CodexManagedConfig, ManagerError> {
        let (config_key, allowed_values) = key.definition();
        if next_value != "default" && !allowed_values.contains(&next_value) {
            return Err(ManagerError::InvalidConfig(
                "不受支持的 Codex 配置值".to_string(),
            ));
        }

        let mut document = self.read_config_document()?;
        if next_value == "default" {
            document.remove(config_key);
        } else {
            document[config_key] = toml_edit_value(next_value);
        }
        self.write_config_document(&document)?;
        Ok(managed_config_from_document(&document))
    }

    pub fn set_codex_context_mode(
        &self,
        mode: CodexContextMode,
    ) -> Result<CodexContextConfig, ManagerError> {
        let mut document = self.read_config_document()?;

        match mode {
            CodexContextMode::Default => {
                document.remove("model_context_window");
                document.remove("model_auto_compact_token_limit");
            }
            CodexContextMode::OneMillion => {
                document["model_context_window"] = toml_edit_value(ONE_MILLION_CONTEXT_WINDOW);
                document["model_auto_compact_token_limit"] =
                    toml_edit_value(ONE_MILLION_AUTO_COMPACT_LIMIT);
            }
        }

        self.write_config_document(&document)?;
        Ok(context_config_from_document(&document))
    }

    pub fn enable_file_credential_storage(&self) -> Result<AppStatus, ManagerError> {
        self.set_codex_config_choice(CodexConfigKey::CredentialStorage, "file")?;
        self.status()
    }

    fn storage_mode(&self) -> Result<String, ManagerError> {
        let document = self.read_config_document()?;
        let configured_item = document.get("cli_auth_credentials_store");
        let safe_mode = match configured_item.and_then(|item| item.as_str()) {
            None if configured_item.is_none() => "file".to_string(),
            Some(mode) => match mode.to_ascii_lowercase().as_str() {
                "file" => "file".to_string(),
                "keyring" => "keyring".to_string(),
                "auto" => "auto".to_string(),
                _ => "unsupported".to_string(),
            },
            None => "unsupported".to_string(),
        };
        Ok(safe_mode)
    }

    fn ensure_file_storage(&self) -> Result<(), ManagerError> {
        let mode = self.storage_mode()?;
        if mode == "file" {
            Ok(())
        } else {
            Err(ManagerError::UnsupportedStorage(mode))
        }
    }

    // 每个会话文件自带 model_provider；这里只回显当前配置与已登记提供方。
    pub fn model_provider_state(&self) -> Result<ModelProviderState, ManagerError> {
        let catalog = self.provider_catalog();
        let active_provider = read_model_provider(&self.config_path());
        let active_id = match active_provider.as_deref() {
            Some(provider) => catalog.usage_id(provider),
            None => ModelProviderKind::Unattributed.provider_id().to_string(),
        };
        Ok(ModelProviderState {
            active_provider,
            active_id,
            providers: provider_options(&catalog),
        })
    }

    fn provider_catalog(&self) -> ProviderCatalog {
        let contents = fs::read_to_string(self.config_path()).unwrap_or_default();
        if contents.trim().is_empty() {
            return ProviderCatalog::default();
        }
        contents
            .parse::<toml::Table>()
            .map(|config| ProviderCatalog::from_config(&config))
            .unwrap_or_default()
    }

    fn read_live_auth(&self) -> Result<Value, ManagerError> {
        read_json(&self.auth_path(), "Codex auth.json")
    }

    fn write_live_auth(&self, auth: &Value) -> Result<(), ManagerError> {
        validate_chatgpt_auth(auth)?;
        write_json(&self.auth_path(), auth)
    }

    fn load_vault(&self) -> Result<Vault, ManagerError> {
        recover_legacy_backup(&self.vault_path)?;
        if !self.vault_path.exists() {
            return Ok(Vault::default());
        }
        let mut vault = read_json::<Vault>(&self.vault_path, "本地账号库")?;
        if vault.version != VAULT_VERSION {
            return Err(ManagerError::InvalidConfig(format!(
                "不支持的账号库版本 {}",
                vault.version
            )));
        }
        self.recover_pending_activation(&mut vault);
        Ok(vault)
    }

    // 只修复内存视图，供状态和本地用量共用，不写回或同步凭据。
    fn recover_pending_activation(&self, vault: &mut Vault) {
        if let Some(pending) = vault.pending_activation.take() {
            let active = self
                .read_live_auth()
                .ok()
                .and_then(|auth| validate_chatgpt_auth(&auth).ok());
            if active.is_some_and(|identity| identity.account_id == pending.account_id) {
                record_activation(vault, &pending.account_id, pending.activated_at);
            }
        }
    }

    fn save_vault(&self, vault: &Vault) -> Result<(), ManagerError> {
        write_json(&self.vault_path, vault)
    }
}

fn validate_label(label: &str) -> Result<&str, ManagerError> {
    let label = label.trim();
    if label.is_empty() {
        return Err(ManagerError::InvalidConfig("账号名称不能为空".to_string()));
    }
    if label.chars().count() > 60 {
        return Err(ManagerError::InvalidConfig(
            "账号名称不能超过 60 个字符".to_string(),
        ));
    }
    Ok(label)
}

// 自动同步只维护已保存账号；新增由保存、登录和导入明确发起。
fn refresh_saved_profile(vault: &mut Vault, auth: Value) -> Result<bool, ManagerError> {
    let Ok(identity) = validate_chatgpt_auth(&auth) else {
        return Ok(false);
    };
    if !vault
        .profiles
        .iter()
        .any(|profile| profile.account_id == identity.account_id)
    {
        return Ok(false);
    }
    upsert_profile(vault, auth, None)
}

fn upsert_profile(
    vault: &mut Vault,
    auth: Value,
    label: Option<&str>,
) -> Result<bool, ManagerError> {
    let identity = validate_chatgpt_auth(&auth)?;
    let now = unix_timestamp();
    if let Some(profile) = vault
        .profiles
        .iter_mut()
        .find(|profile| profile.account_id == identity.account_id)
    {
        let changed = label.is_some_and(|label| profile.label != label)
            || profile.email != identity.email
            || profile.auth != auth;
        if !changed {
            return Ok(false);
        }
        if let Some(label) = label {
            profile.label = label.to_string();
        }
        profile.email = identity.email;
        profile.auth = auth;
        profile.updated_at = now;
        return Ok(true);
    }

    let default_label = identity
        .email
        .as_deref()
        .unwrap_or("未命名账号")
        .to_string();
    vault.profiles.push(ProfileRecord {
        id: identity.account_id.clone(),
        label: label.unwrap_or(&default_label).to_string(),
        account_id: identity.account_id,
        email: identity.email,
        auth,
        created_at: now,
        updated_at: now,
    });
    Ok(true)
}

fn record_activation(vault: &mut Vault, account_id: &str, activated_at: u64) -> bool {
    if vault
        .activations
        .last()
        .is_some_and(|activation| activation.account_id == account_id)
    {
        return false;
    }
    vault.activations.push(ActivationRecord {
        account_id: account_id.to_string(),
        activated_at,
    });
    if vault.activations.len() > MAX_ACTIVATION_RECORDS {
        let overflow = vault.activations.len() - MAX_ACTIVATION_RECORDS;
        vault.activations.drain(..overflow);
    }
    true
}

// OpenAI 默认提供方固定占一项，其余按 config 中登记的 provider 逐个列出。
fn provider_options(catalog: &ProviderCatalog) -> Vec<ModelProviderOption> {
    let mut options = vec![ModelProviderOption {
        id: ModelProviderKind::Openai.provider_id().to_string(),
        label: provider_label(ModelProviderKind::Openai).to_string(),
        kind: ModelProviderKind::Openai,
    }];
    options.extend(
        catalog
            .known_providers()
            .into_iter()
            .map(|(id, label)| ModelProviderOption {
                id: catalog.usage_id(&id),
                label,
                kind: ModelProviderKind::ThirdParty,
            }),
    );
    options
}

fn read_model_provider(config_path: &Path) -> Option<String> {
    let contents = fs::read_to_string(config_path).ok()?;
    if contents.trim().is_empty() {
        return None;
    }
    contents
        .parse::<toml::Table>()
        .ok()?
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(|value| value.to_string())
}

fn context_config_state(
    context_window: Option<i64>,
    auto_compact_token_limit: Option<i64>,
) -> CodexContextConfig {
    let mode = if context_window.is_none() && auto_compact_token_limit.is_none() {
        "default"
    } else if context_window == Some(ONE_MILLION_CONTEXT_WINDOW)
        && auto_compact_token_limit == Some(ONE_MILLION_AUTO_COMPACT_LIMIT)
    {
        "oneMillion"
    } else {
        "custom"
    };
    CodexContextConfig {
        mode: mode.to_string(),
        context_window,
        auto_compact_token_limit,
    }
}

fn context_config_from_document(document: &DocumentMut) -> CodexContextConfig {
    context_config_state(
        document
            .get("model_context_window")
            .and_then(|item| item.as_integer()),
        document
            .get("model_auto_compact_token_limit")
            .and_then(|item| item.as_integer()),
    )
}

fn choice_config_state(document: &DocumentMut, config_key: CodexConfigKey) -> CodexChoiceConfig {
    let (key, allowed_values) = config_key.definition();
    let Some(item) = document.get(key) else {
        return CodexChoiceConfig {
            value: "default".to_string(),
        };
    };
    let value = item
        .as_str()
        .filter(|value| allowed_values.contains(value))
        .unwrap_or("custom");
    CodexChoiceConfig {
        value: value.to_string(),
    }
}

fn managed_config_from_document(document: &DocumentMut) -> CodexManagedConfig {
    CodexManagedConfig {
        credential_storage: choice_config_state(document, CodexConfigKey::CredentialStorage),
        context: context_config_from_document(document),
        reasoning_effort: choice_config_state(document, CodexConfigKey::ReasoningEffort),
        reasoning_summary: choice_config_state(document, CodexConfigKey::ReasoningSummary),
        model_verbosity: choice_config_state(document, CodexConfigKey::ModelVerbosity),
        web_search: choice_config_state(document, CodexConfigKey::WebSearch),
    }
}
pub(crate) fn validate_chatgpt_auth(auth: &Value) -> Result<AuthIdentity, ManagerError> {
    if auth.get("auth_mode").and_then(Value::as_str) != Some("chatgpt") {
        return Err(ManagerError::InvalidAuth(
            "当前不是 ChatGPT 订阅登录，API Key 登录不会被保存".to_string(),
        ));
    }
    let tokens = auth
        .get("tokens")
        .and_then(Value::as_object)
        .ok_or_else(|| ManagerError::InvalidAuth("Codex auth.json 缺少 tokens".to_string()))?;
    for field in ["access_token", "refresh_token"] {
        let present = tokens
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty());
        if !present {
            return Err(ManagerError::InvalidAuth(format!(
                "Codex auth.json 缺少 {field}"
            )));
        }
    }

    let id_claims = tokens
        .get("id_token")
        .and_then(Value::as_str)
        .and_then(parse_claims);
    let access_claims = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .and_then(parse_claims);
    let declared_account_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string);
    let claimed_account_ids = [
        id_claims.as_ref().and_then(direct_account_id_from_claims),
        access_claims
            .as_ref()
            .and_then(direct_account_id_from_claims),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    if claimed_account_ids.first().is_some_and(|first| {
        claimed_account_ids
            .iter()
            .any(|account_id| account_id != first)
    }) || declared_account_id.as_ref().is_some_and(|declared| {
        claimed_account_ids
            .iter()
            .any(|account_id| account_id != declared)
    }) {
        return Err(ManagerError::InvalidAuth(
            "Codex auth.json 中的账号身份不一致".to_string(),
        ));
    }
    let account_id = declared_account_id
        .or_else(|| account_id_from_claims(id_claims.as_ref()))
        .or_else(|| account_id_from_claims(access_claims.as_ref()))
        .ok_or_else(|| ManagerError::InvalidAuth("无法识别当前 ChatGPT 账号 ID".to_string()))?;
    let email = id_claims
        .as_ref()
        .and_then(|claims| claims.email.clone())
        .or_else(|| {
            access_claims
                .as_ref()
                .and_then(|claims| claims.email.clone())
        });
    Ok(AuthIdentity { account_id, email })
}

fn canonical_chatgpt_auth(auth: &Value) -> Result<Value, ManagerError> {
    let identity = validate_chatgpt_auth(auth)?;
    let tokens = auth
        .get("tokens")
        .and_then(Value::as_object)
        .ok_or_else(|| ManagerError::InvalidAuth("Codex auth.json 缺少 tokens".to_string()))?;
    let mut normalized_tokens = serde_json::Map::new();
    for field in ["id_token", "access_token", "refresh_token"] {
        if let Some(value) = tokens.get(field) {
            normalized_tokens.insert(field.to_string(), value.clone());
        }
    }
    normalized_tokens.insert("account_id".to_string(), Value::String(identity.account_id));
    let mut normalized = serde_json::Map::new();
    normalized.insert(
        "auth_mode".to_string(),
        Value::String("chatgpt".to_string()),
    );
    normalized.insert("OPENAI_API_KEY".to_string(), Value::Null);
    normalized.insert("tokens".to_string(), Value::Object(normalized_tokens));
    if let Some(last_refresh) = auth.get("last_refresh").and_then(Value::as_str) {
        normalized.insert(
            "last_refresh".to_string(),
            Value::String(last_refresh.to_string()),
        );
    }
    let normalized = Value::Object(normalized);
    validate_chatgpt_auth(&normalized)?;
    Ok(normalized)
}

fn parse_claims(token: &str) -> Option<TokenClaims> {
    let mut parts = token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let _signature = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn account_id_from_claims(claims: Option<&TokenClaims>) -> Option<String> {
    let claims = claims?;
    direct_account_id_from_claims(claims).or_else(|| {
        claims
            .organizations
            .first()
            .and_then(|organization| organization.id.clone())
    })
}

fn direct_account_id_from_claims(claims: &TokenClaims) -> Option<String> {
    claims.chatgpt_account_id.clone().or_else(|| {
        claims
            .openai_auth
            .as_ref()
            .and_then(|auth| auth.chatgpt_account_id.clone())
    })
}

async fn query_account_details(
    auth: &Value,
    account_id: &str,
) -> (QuotaQueryResult, Option<Value>) {
    let outcome = codex_app_server::query_account(auth).await;
    let mut refreshed_auth = match outcome.refreshed_auth {
        Some(auth) => match checked_refreshed_auth(&auth, account_id) {
            Ok(auth) => Some(auth),
            Err(error) => return (Err(QuotaQueryError::Message(error.to_string())), None),
        },
        None => None,
    };
    match outcome.result {
        Err(codex_app_server::AppServerError::RateLimited) => {
            return (
                Err(QuotaQueryError::Message(
                    "额度服务请求过于频繁，请稍后重试".to_string(),
                )),
                refreshed_auth,
            );
        }
        Err(_) => {}
        Ok(snapshot) => {
            if snapshot
                .rate_limits
                .account_id
                .as_deref()
                .is_some_and(|id| id != account_id)
            {
                return (
                    Err(QuotaQueryError::Message(
                        "官方账户响应与本地账号不一致，请重新登录".to_string(),
                    )),
                    refreshed_auth,
                );
            }
            return (Ok(official_quota_details(snapshot)), refreshed_auth);
        }
    }

    // App Server 即使失败也可能已经轮换令牌，兼容路径必须从新凭据继续。
    let current_auth = refreshed_auth.as_ref().unwrap_or(auth);
    let mut result = query_account_quota_compatibility(current_auth, account_id).await;
    if matches!(result, Err(QuotaQueryError::Unauthorized)) {
        match refresh_codex_auth(current_auth)
            .await
            .and_then(|auth| checked_refreshed_auth(&auth, account_id))
        {
            Ok(next_auth) => {
                result = query_account_quota_compatibility(&next_auth, account_id).await;
                refreshed_auth = Some(next_auth);
            }
            Err(error) => result = Err(QuotaQueryError::Message(error.to_string())),
        }
    }
    (result, refreshed_auth)
}

fn checked_refreshed_auth(auth: &Value, account_id: &str) -> Result<Value, ManagerError> {
    let auth = canonical_chatgpt_auth(auth)?;
    if validate_chatgpt_auth(&auth)?.account_id != account_id {
        return Err(ManagerError::InvalidAuth(
            "官方账户响应与本地账号不一致，请重新登录".to_string(),
        ));
    }
    Ok(auth)
}

fn official_quota_details(snapshot: codex_app_server::AccountSnapshot) -> QuotaDetails {
    let codex_app_server::AccountSnapshot {
        plan_type,
        rate_limits,
        usage,
    } = snapshot;
    let mut buckets = rate_limits
        .rate_limits_by_limit_id
        .unwrap_or_default()
        .into_iter()
        .map(|(id, limit)| QuotaBucket {
            id,
            name: limit.limit_name,
            primary: limit.primary.map(official_usage_window),
            secondary: limit.secondary.map(official_usage_window),
        })
        .collect::<Vec<_>>();
    let limit = &rate_limits.rate_limits;
    let default_id = limit
        .limit_id
        .clone()
        .unwrap_or_else(|| "codex".to_string());
    if buckets.is_empty() || !buckets.iter().any(|bucket| bucket.id == default_id) {
        buckets.push(QuotaBucket {
            id: default_id,
            name: limit.limit_name.clone(),
            primary: limit.primary.clone().map(official_usage_window),
            secondary: limit.secondary.clone().map(official_usage_window),
        });
    }
    buckets.sort_by(|left, right| {
        (left.id != "codex")
            .cmp(&(right.id != "codex"))
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.id.cmp(&right.id))
    });

    let default_bucket = buckets
        .iter()
        .find(|bucket| bucket.id == "codex")
        .or_else(|| buckets.first());
    let reset_credits = rate_limits.rate_limit_reset_credits.map(|credits| {
        let mut expires_at = credits
            .credits
            .unwrap_or_default()
            .into_iter()
            .filter(|credit| credit.status == "available")
            .filter_map(|credit| credit.expires_at)
            .collect::<Vec<_>>();
        expires_at.sort_unstable();
        expires_at.dedup();
        UsageResetCredits {
            available_count: credits.available_count,
            expires_at,
        }
    });

    QuotaDetails {
        primary: default_bucket.and_then(|bucket| bucket.primary.clone()),
        secondary: default_bucket.and_then(|bucket| bucket.secondary.clone()),
        buckets,
        reset_credits,
        plan_type,
        official_usage: usage.map(|usage| AccountUsageSummary {
            lifetime_tokens: usage.summary.lifetime_tokens,
            peak_daily_tokens: usage.summary.peak_daily_tokens,
            longest_running_turn_sec: usage.summary.longest_running_turn_sec,
            current_streak_days: usage.summary.current_streak_days,
            longest_streak_days: usage.summary.longest_streak_days,
            daily_usage_buckets: usage
                .daily_usage_buckets
                .into_iter()
                .map(|bucket| AccountUsageDailyBucket {
                    start_date: bucket.start_date,
                    tokens: bucket.tokens,
                })
                .collect(),
        }),
        source: "appServer".to_string(),
    }
}

fn official_usage_window(window: codex_app_server::RateLimitWindow) -> UsageWindow {
    UsageWindow {
        used_percent: window.used_percent.clamp(0.0, 100.0),
        window_minutes: window.window_duration_mins,
        resets_at: window.resets_at,
    }
}

async fn query_account_quota_compatibility(auth: &Value, account_id: &str) -> QuotaQueryResult {
    let access_token = auth
        .pointer("/tokens/access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| QuotaQueryError::Message("账号缺少可用的访问凭据".to_string()))?;
    let client = quota_client()?;
    let (primary, secondary, available_count) =
        query_usage_windows(&client, access_token, account_id).await?;
    // 重置次数是附加信息，顺序查询可避免每个账号同时冲击两个兼容端点。
    let reset_credits = match query_reset_credits(&client, access_token, account_id).await {
        Ok(response) => Some(to_usage_reset_credits(response, available_count)),
        Err(_) => available_count.map(|available_count| UsageResetCredits {
            available_count,
            expires_at: Vec::new(),
        }),
    };
    Ok(QuotaDetails {
        primary,
        secondary,
        buckets: Vec::new(),
        reset_credits,
        plan_type: None,
        official_usage: None,
        source: "compatibility".to_string(),
    })
}

fn quota_retry_delay(response: Option<&Response>, account_id: &str) -> Option<Duration> {
    let retry_after = response
        .and_then(|response| response.headers().get(RETRY_AFTER))
        .and_then(|value| value.to_str().ok());
    quota_retry_delay_value(retry_after, account_id, Utc::now())
}

fn quota_retry_delay_value(
    retry_after: Option<&str>,
    account_id: &str,
    now: chrono::DateTime<Utc>,
) -> Option<Duration> {
    if let Some(value) = retry_after {
        let delay = parse_retry_after(value, now);
        return match delay {
            Some(delay) if delay <= Duration::from_secs(QUOTA_RETRY_MAX_DELAY_SECS) => Some(delay),
            Some(_) => None,
            None => Some(default_quota_retry_delay(account_id)),
        };
    }
    Some(default_quota_retry_delay(account_id))
}

fn parse_retry_after(value: &str, now: chrono::DateTime<Utc>) -> Option<Duration> {
    if let Ok(seconds) = value.trim().parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let retry_at = chrono::NaiveDateTime::parse_from_str(value.trim(), "%a, %d %b %Y %H:%M:%S GMT")
        .ok()?
        .and_utc();
    let seconds = retry_at.signed_duration_since(now).num_seconds().max(0);
    Some(Duration::from_secs(seconds as u64))
}

fn default_quota_retry_delay(account_id: &str) -> Duration {
    let jitter = account_id
        .bytes()
        .fold(0_u64, |sum, byte| sum.wrapping_add(u64::from(byte)))
        % 200;
    Duration::from_millis(QUOTA_RETRY_BASE_DELAY_MS + jitter)
}

async fn send_quota_request(
    client: &Client,
    url: &str,
    access_token: &str,
    account_id: &str,
    service_name: &str,
) -> Result<Response, QuotaQueryError> {
    for attempt in 0..2 {
        let response = client
            .get(url)
            .bearer_auth(access_token)
            .header("Accept", "application/json")
            .header("ChatGPT-Account-Id", account_id)
            .send()
            .await;
        match response {
            Ok(response)
                if attempt == 0
                    && (response.status() == StatusCode::TOO_MANY_REQUESTS
                        || response.status().is_server_error()) =>
            {
                let Some(delay) = quota_retry_delay(Some(&response), account_id) else {
                    return Ok(response);
                };
                sleep(delay).await;
            }
            Ok(response) => return Ok(response),
            Err(error) if attempt == 0 && (error.is_timeout() || error.is_connect()) => {
                sleep(default_quota_retry_delay(account_id)).await;
            }
            Err(error) => {
                let message = if error.is_timeout() {
                    format!("{service_name}查询超时")
                } else if error.is_connect() {
                    format!("无法连接{service_name}服务")
                } else {
                    format!("{service_name}查询网络失败")
                };
                return Err(QuotaQueryError::Message(message));
            }
        }
    }
    Err(QuotaQueryError::Message(format!(
        "{service_name}服务暂不可用"
    )))
}

async fn query_usage_windows(
    client: &Client,
    access_token: &str,
    account_id: &str,
) -> Result<(Option<UsageWindow>, Option<UsageWindow>, Option<u64>), QuotaQueryError> {
    let response =
        send_quota_request(client, CODEX_USAGE_URL, access_token, account_id, "额度").await?;

    if matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        return Err(QuotaQueryError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(QuotaQueryError::Message(format!(
            "额度服务暂不可用（HTTP {}）",
            response.status()
        )));
    }

    let body: CodexUsageResponse = response
        .json()
        .await
        .map_err(|_| QuotaQueryError::Message("额度服务返回了无法识别的响应".to_string()))?;
    let available_count = body
        .rate_limit_reset_credits
        .and_then(|credits| credits.available_count);
    let Some(rate_limit) = body.rate_limit else {
        return Ok((None, None, available_count));
    };
    Ok((
        rate_limit.primary_window.and_then(to_usage_window),
        rate_limit.secondary_window.and_then(to_usage_window),
        available_count,
    ))
}

async fn query_reset_credits(
    client: &Client,
    access_token: &str,
    account_id: &str,
) -> Result<CodexResetCreditsResponse, QuotaQueryError> {
    let response = send_quota_request(
        client,
        CODEX_RESET_CREDITS_URL,
        access_token,
        account_id,
        "重置额度",
    )
    .await?;

    if matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        return Err(QuotaQueryError::Unauthorized);
    }
    if !response.status().is_success() {
        return Err(QuotaQueryError::Message(format!(
            "重置额度服务暂不可用（HTTP {}）",
            response.status()
        )));
    }

    response
        .json()
        .await
        .map_err(|_| QuotaQueryError::Message("重置额度服务返回了无法识别的响应".to_string()))
}

fn to_usage_reset_credits(
    response: CodexResetCreditsResponse,
    summary_available_count: Option<u64>,
) -> UsageResetCredits {
    let is_available = |credit: &&CodexResetCredit| {
        credit.status.as_deref() == Some("available") && credit.is_supported_by_plan.unwrap_or(true)
    };
    let mut expires_at = response
        .credits
        .iter()
        .filter(is_available)
        .filter_map(|credit| credit.expires_at.as_deref())
        .filter_map(|expires_at| chrono::DateTime::parse_from_rfc3339(expires_at).ok())
        .filter_map(|expires_at| u64::try_from(expires_at.timestamp()).ok())
        .collect::<Vec<_>>();
    expires_at.sort_unstable();
    expires_at.dedup();

    let available_count = response
        .available_count
        .or(summary_available_count)
        .unwrap_or_else(|| response.credits.iter().filter(is_available).count() as u64);

    UsageResetCredits {
        available_count,
        expires_at,
    }
}

fn to_usage_window(window: CodexRateLimitWindow) -> Option<UsageWindow> {
    Some(UsageWindow {
        used_percent: window.used_percent?.clamp(0.0, 100.0),
        window_minutes: window
            .limit_window_seconds
            .map(|seconds| seconds.saturating_add(59) / 60),
        resets_at: window.reset_at,
    })
}

async fn refresh_codex_auth(auth: &Value) -> Result<Value, ManagerError> {
    let refresh_token = auth
        .pointer("/tokens/refresh_token")
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| ManagerError::InvalidAuth("账号缺少 refresh_token".to_string()))?;
    let refreshed = exchange_refresh_token(refresh_token, "请重新登录").await?;

    let mut next = auth.clone();
    let tokens = next
        .get_mut("tokens")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| ManagerError::InvalidAuth("Codex auth.json 缺少 tokens".to_string()))?;
    tokens.insert(
        "access_token".to_string(),
        Value::String(refreshed.access_token),
    );
    if let Some(refresh_token) = refreshed
        .refresh_token
        .filter(|token| !token.trim().is_empty())
    {
        tokens.insert("refresh_token".to_string(), Value::String(refresh_token));
    }
    if let Some(id_token) = refreshed.id_token.filter(|token| !token.trim().is_empty()) {
        tokens.insert("id_token".to_string(), Value::String(id_token));
    }
    if let Some(root) = next.as_object_mut() {
        root.insert(
            "last_refresh".to_string(),
            Value::String(Utc::now().to_rfc3339()),
        );
    }
    validate_chatgpt_auth(&next)?;
    Ok(next)
}

// OAuth 刷新端点及其响应格式属于 Codex 本地凭据兼容层；业务流程只接收结构化结果，
// 不记录请求中的 refresh_token，也不把响应正文带入错误信息。
async fn exchange_refresh_token(
    refresh_token: &str,
    failure_hint: &str,
) -> Result<OAuthTokenResponse, ManagerError> {
    let response = oauth_client()?
        .post(OAUTH_TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", CODEX_CLIENT_ID),
        ])
        .send()
        .await
        .map_err(|error| network_error("刷新订阅凭据", error))?;
    if !response.status().is_success() {
        return Err(ManagerError::TokenExchange(format!(
            "刷新订阅凭据失败（HTTP {}），{failure_hint}",
            response.status(),
        )));
    }
    let refreshed: OAuthTokenResponse = response
        .json()
        .await
        .map_err(|_| ManagerError::TokenExchange("登录服务返回了无法识别的刷新响应".to_string()))?;
    if refreshed.access_token.trim().is_empty() {
        return Err(ManagerError::TokenExchange(format!(
            "刷新响应缺少 access_token，{failure_hint}"
        )));
    }
    Ok(refreshed)
}

fn oauth_client() -> Result<Client, ManagerError> {
    proxy::cached_client(
        USER_AGENT,
        Duration::from_secs(OAUTH_QUERY_TIMEOUT_SECS),
        || "无法初始化登录服务客户端".to_string(),
    )
    .map_err(|message| ManagerError::Network(message))
}

fn quota_client() -> Result<Client, QuotaQueryError> {
    proxy::cached_client(
        USER_AGENT,
        Duration::from_secs(USAGE_QUERY_TIMEOUT_SECS),
        || "无法初始化额度查询".to_string(),
    )
    .map_err(|message| QuotaQueryError::Message(message))
}

fn network_error(action: &str, error: reqwest::Error) -> ManagerError {
    let detail = if error.is_timeout() {
        "请求超时"
    } else if error.is_connect() {
        "无法连接登录服务"
    } else {
        "网络请求失败"
    };
    ManagerError::Network(format!("{action}失败：{detail}"))
}

fn parse_interval(value: Option<&Value>) -> u64 {
    let raw = match value {
        Some(Value::Number(number)) => number.as_u64().unwrap_or(5),
        Some(Value::String(text)) => text.parse::<u64>().unwrap_or(5),
        _ => 5,
    };
    raw.max(1) + POLLING_SAFETY_MARGIN_SECS
}

async fn exchange_code_for_tokens(
    authorization_code: &str,
    code_verifier: &str,
) -> Result<OAuthTokenResponse, ManagerError> {
    let response = oauth_client()?
        .post(OAUTH_TOKEN_URL)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", authorization_code),
            ("redirect_uri", DEVICE_REDIRECT_URI),
            ("client_id", CODEX_CLIENT_ID),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await
        .map_err(|error| network_error("交换登录凭据", error))?;

    if !response.status().is_success() {
        return Err(ManagerError::TokenExchange(format!(
            "交换登录凭据失败（HTTP {}），请重新登录",
            response.status()
        )));
    }

    response
        .json()
        .await
        .map_err(|_| ManagerError::TokenExchange("登录服务返回了无法识别的凭据响应".to_string()))
}

fn materialize_codex_auth(tokens: OAuthTokenResponse) -> Result<Value, ManagerError> {
    let refresh_token = tokens
        .refresh_token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| {
            ManagerError::TokenExchange("登录响应缺少 refresh_token，请重新登录".to_string())
        })?;
    let id_token = tokens
        .id_token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| {
            ManagerError::TokenExchange("登录响应缺少 id_token，请重新登录".to_string())
        })?;
    if tokens.access_token.trim().is_empty() {
        return Err(ManagerError::TokenExchange(
            "登录响应缺少 access_token，请重新登录".to_string(),
        ));
    }

    let claims = parse_claims(&id_token).or_else(|| parse_claims(&tokens.access_token));
    let account_id = account_id_from_claims(claims.as_ref()).ok_or_else(|| {
        ManagerError::InvalidAuth("无法从登录凭据中识别 ChatGPT 账号 ID".to_string())
    })?;

    Ok(serde_json::json!({
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": null,
        "tokens": {
            "id_token": id_token,
            "access_token": tokens.access_token,
            "refresh_token": refresh_token,
            "account_id": account_id,
        },
        "last_refresh": Utc::now().to_rfc3339(),
    }))
}

fn materialize_transferred_auth(
    transferred_id_token: String,
    transferred_account_id: String,
    refreshed: OAuthTokenResponse,
) -> Result<Value, ManagerError> {
    let refresh_token = refreshed
        .refresh_token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| {
            ManagerError::TokenExchange(
                "一次性迁移的刷新响应缺少 refresh_token，未导入任何内容".to_string(),
            )
        })?;
    if refreshed.access_token.trim().is_empty() {
        return Err(ManagerError::TokenExchange(
            "一次性迁移的刷新响应缺少 access_token，未导入任何内容".to_string(),
        ));
    }
    let refreshed_id_token = refreshed.id_token.filter(|token| !token.trim().is_empty());
    let id_token_account_id = refreshed_id_token
        .as_deref()
        .map(account_id_from_transferred_id_token)
        .transpose()
        .map_err(|_| {
            ManagerError::InvalidAuth("刷新响应中的 id_token 无效，未导入任何内容".to_string())
        })?;
    let access_token_account_id = parse_claims(&refreshed.access_token)
        .as_ref()
        .and_then(|claims| account_id_from_claims(Some(claims)));

    if id_token_account_id.is_none() && access_token_account_id.is_none() {
        return Err(ManagerError::InvalidAuth(
            "刷新响应无法识别 ChatGPT 账号 ID，未导入任何内容".to_string(),
        ));
    }
    for account_id in [id_token_account_id, access_token_account_id]
        .into_iter()
        .flatten()
    {
        if account_id != transferred_account_id {
            return Err(ManagerError::InvalidAuth(
                "刷新后的凭据与一次性迁移账号不一致，未导入任何内容".to_string(),
            ));
        }
    }
    let id_token = refreshed_id_token.unwrap_or(transferred_id_token);

    let auth = serde_json::json!({
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": null,
        "tokens": {
            "id_token": id_token,
            "access_token": refreshed.access_token,
            "refresh_token": refresh_token,
            "account_id": transferred_account_id,
        },
        "last_refresh": Utc::now().to_rfc3339(),
    });
    validate_chatgpt_auth(&auth)?;

    Ok(auth)
}

fn account_id_from_transferred_id_token(id_token: &str) -> Result<String, ManagerError> {
    parse_claims(id_token)
        .as_ref()
        .and_then(|claims| account_id_from_claims(Some(claims)))
        .ok_or_else(|| {
            ManagerError::InvalidAuth("无法从一次性迁移内容中识别 ChatGPT 账号 ID".to_string())
        })
}

fn transfer_seed(imported: ImportedAuth) -> Result<TransferSeed, ManagerError> {
    match imported {
        ImportedAuth::RefreshSeed {
            id_token,
            refresh_token,
        } => {
            let account_id = account_id_from_transferred_id_token(&id_token)?;
            Ok(TransferSeed {
                label: None,
                id_token,
                refresh_token,
                account_id,
            })
        }
        ImportedAuth::LegacySnapshot { label, auth } => {
            let label = validate_label(&label)?.to_string();
            let auth = canonical_chatgpt_auth(&auth)?;
            let identity = validate_chatgpt_auth(&auth)?;
            let id_token = auth
                .pointer("/tokens/id_token")
                .and_then(Value::as_str)
                .filter(|token| !token.trim().is_empty())
                .ok_or_else(|| {
                    ManagerError::InvalidAuth(
                        "旧版迁移内容缺少 id_token，未导入任何内容".to_string(),
                    )
                })?
                .to_string();
            let account_id = account_id_from_transferred_id_token(&id_token)?;
            if account_id != identity.account_id {
                return Err(ManagerError::InvalidAuth(
                    "旧版迁移内容中的账号身份不一致，未导入任何内容".to_string(),
                ));
            }
            let refresh_token = auth
                .pointer("/tokens/refresh_token")
                .and_then(Value::as_str)
                .filter(|token| !token.trim().is_empty())
                .ok_or_else(|| {
                    ManagerError::InvalidAuth(
                        "旧版迁移内容缺少 refresh_token，未导入任何内容".to_string(),
                    )
                })?
                .to_string();
            Ok(TransferSeed {
                label: Some(label),
                id_token,
                refresh_token,
                account_id,
            })
        }
    }
}

fn read_json<T: serde::de::DeserializeOwned>(
    path: &Path,
    description: &str,
) -> Result<T, ManagerError> {
    recover_legacy_backup(path)?;
    let contents = fs::read(path).map_err(|error| {
        ManagerError::Io(format!(
            "读取 {description}（{}）失败: {error}",
            path.display()
        ))
    })?;
    serde_json::from_slice(&contents)
        .map_err(|_| ManagerError::InvalidAuth(format!("{description} 格式错误，请检查文件内容")))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), ManagerError> {
    let mut contents = serde_json::to_vec_pretty(value)
        .map_err(|error| ManagerError::Io(format!("序列化认证数据失败: {error}")))?;
    contents.push(b'\n');
    atomic_write(path, &contents)
}

// 兼容旧版 Windows 两步替换中断后留下的备份。目标存在时不覆盖、不删除备份。
#[cfg(windows)]
fn recover_legacy_backup(path: &Path) -> Result<(), ManagerError> {
    let backup = path.with_extension("cam-backup");
    if !path.exists() && backup.is_file() {
        fs::rename(&backup, path)
            .map_err(|error| ManagerError::Io(format!("恢复旧认证备份失败: {error}")))?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn recover_legacy_backup(_path: &Path) -> Result<(), ManagerError> {
    Ok(())
}

pub(crate) fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), ManagerError> {
    recover_legacy_backup(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| ManagerError::Io(format!("无法定位 {} 的父目录", path.display())))?;
    fs::create_dir_all(parent).map_err(|error| {
        ManagerError::Io(format!("创建目录 {} 失败: {error}", parent.display()))
    })?;
    secure_directory(parent)?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("credentials");
    let mut temporary = tempfile::Builder::new()
        .prefix(&format!(".{file_name}.cam-"))
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|error| ManagerError::Io(format!("创建临时认证文件失败: {error}")))?;
    temporary
        .write_all(contents)
        .map_err(|error| ManagerError::Io(format!("写入临时认证文件失败: {error}")))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| ManagerError::Io(format!("同步临时认证文件失败: {error}")))?;
    // tempfile 在 Windows 使用 MoveFileExW(REPLACE_EXISTING)，不会先移走目标文件。
    temporary.persist(path).map_err(|error| {
        ManagerError::Io(format!("原子替换 {} 失败: {}", path.display(), error.error))
    })?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| ManagerError::Io(format!("同步认证目录失败: {error}")))?;
    Ok(())
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<(), ManagerError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| ManagerError::Io(format!("设置目录 {} 权限失败: {error}", path.display())))
}

#[cfg(not(unix))]
fn secure_directory(_path: &Path) -> Result<(), ManagerError> {
    Ok(())
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use tempfile::TempDir;

    #[test]
    fn local_usage_and_provider_state_work_without_file_credentials() {
        for mode in ["auto", "keyring"] {
            let (_root, manager) = test_manager();
            manager
                .write_live_auth(&auth("account-a", "a@example.com", "synthetic-a"))
                .unwrap();
            manager.save_current("账号 A").unwrap();
            write_config(
                &manager,
                &format!("cli_auth_credentials_store = \"{mode}\"\nmodel_provider = \"custom\"\n"),
            );
            let sessions = manager.codex_home.join("sessions");
            fs::create_dir_all(&sessions).unwrap();
            fs::write(sessions.join("session.jsonl"), format!("{}\n", json!({
                "timestamp": Utc::now().to_rfc3339(), "type":"event_msg",
                "payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":123}}}
            }))).unwrap();
            let auth_before = fs::read(manager.auth_path()).unwrap();
            let vault_before = fs::read(&manager.vault_path).unwrap();
            let stats =
                tauri::async_runtime::block_on(manager.local_usage(&Mutex::new(()))).unwrap();
            assert_eq!(stats.today.total_tokens, 123);
            assert_eq!(
                manager.model_provider_state().unwrap().active_id,
                "provider:custom"
            );
            assert!(fs::read(manager.auth_path()).unwrap() == auth_before);
            assert!(fs::read(&manager.vault_path).unwrap() == vault_before);
            // 配置或账号库损坏时，原始会话计数也应保持可读。
            fs::write(&manager.vault_path, b"invalid vault").unwrap();
            write_config(&manager, "invalid toml = [");
            assert_eq!(
                tauri::async_runtime::block_on(manager.local_usage(&Mutex::new(())))
                    .unwrap()
                    .today
                    .total_tokens,
                123
            );
            assert!(manager.model_provider_state().is_ok());
        }
    }

    #[test]
    fn quota_selection_contains_only_requested_saved_accounts() {
        let (_root, manager) = test_manager();
        for id in ["account-a", "account-b"] {
            manager
                .write_live_auth(&auth(id, "test@example.com", "synthetic-refresh"))
                .unwrap();
            manager.save_current(id).unwrap();
        }
        let targets = manager.quota_targets(Some(&["account-a".into()])).unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].0, "account-a");
        assert_eq!(manager.quota_targets(None).unwrap().len(), 2);
        assert!(manager.quota_targets(Some(&[])).unwrap().is_empty());
        assert!(matches!(
            manager.quota_targets(Some(&["missing".into()])),
            Err(ManagerError::ProfileNotFound)
        ));
    }

    #[test]
    fn quota_updates_are_delivered_and_persisted_before_the_batch_finishes() {
        tauri::async_runtime::block_on(async {
            let (_root, manager) = test_manager();
            let original = auth("account-a", "a@example.com", "synthetic-a");
            let rotated = auth("account-a", "a@example.com", "synthetic-rotated");
            manager.write_live_auth(&original).unwrap();
            manager.save_current("账号 A").unwrap();
            let second = auth("account-b", "b@example.com", "synthetic-b");
            manager.write_live_auth(&second).unwrap();
            manager.save_current("账号 B").unwrap();
            let (arrived_tx, arrived_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = tokio::sync::oneshot::channel();
            let arrived_tx = std::sync::Mutex::new(Some(arrived_tx));
            let first = QuotaOutcome {
                query_permit: None,
                profile_id: "account-a".into(),
                account_id: "account-a".into(),
                original_auth: original,
                queried_at: unix_timestamp(),
                result: Err(QuotaQueryError::Unauthorized),
                refreshed_auth: Some(rotated.clone()),
            };
            let outcomes = stream::once(async { Ok(first) }).chain(stream::once(async {
                release_rx.await.unwrap();
                Ok(QuotaOutcome {
                    query_permit: None,
                    profile_id: "account-b".into(),
                    account_id: "account-b".into(),
                    original_auth: second,
                    queried_at: unix_timestamp(),
                    result: Err(QuotaQueryError::Unauthorized),
                    refreshed_auth: None,
                })
            }));
            let gate = Mutex::new(());
            let collect = manager.collect_quota_outcomes(outcomes, &gate, |quota| {
                if quota.profile_id == "account-a" {
                    arrived_tx.lock().unwrap().take().unwrap().send(()).unwrap();
                }
            });
            let observe = async {
                arrived_rx.await.unwrap();
                assert!(
                    manager
                        .load_vault()
                        .unwrap()
                        .profiles
                        .iter()
                        .find(|profile| profile.id == "account-a")
                        .unwrap()
                        .auth
                        == rotated
                );
                release_tx.send(()).unwrap();
            };
            let (result, ()) = futures_util::future::join(collect, observe).await;
            assert_eq!(result.unwrap().len(), 2);
        });
    }

    #[test]
    fn config_and_vault_parse_errors_do_not_include_source_values() {
        let (_root, manager) = test_manager();
        write_config(
            &manager,
            "bearer_token = \"SYNTHETIC_SECRET_MARKER\" invalid\n",
        );
        let error = manager.codex_managed_config().unwrap_err().to_string();
        assert!(!error.contains("SYNTHETIC_SECRET_MARKER"));
        assert!(!error.contains("bearer_token"));
        fs::create_dir_all(manager.vault_path.parent().unwrap()).unwrap();
        fs::write(
            &manager.vault_path,
            r#"{"version":"SYNTHETIC_SECRET_MARKER","profiles":[]}"#,
        )
        .unwrap();
        assert!(!manager
            .load_vault()
            .unwrap_err()
            .to_string()
            .contains("SYNTHETIC_SECRET_MARKER"));
    }

    #[test]
    fn passive_refresh_and_switch_do_not_restore_a_removed_profile() {
        let (_root, manager) = test_manager();
        manager
            .write_live_auth(&auth("account-b", "b@example.com", "synthetic-b"))
            .unwrap();
        manager.save_current("保留账号").unwrap();
        manager
            .write_live_auth(&auth("account-a", "a@example.com", "synthetic-a"))
            .unwrap();
        manager.save_current("待移除账号").unwrap();
        manager.remove_account("account-a").unwrap();
        // 用量和额度共用此入口；读取当前登录仍有效，但不重新保存。
        let (vault, active) = manager.load_usage_vault().unwrap();
        assert_eq!(active.as_deref(), Some("account-a"));
        assert!(vault
            .profiles
            .iter()
            .all(|profile| profile.id != "account-a"));
        manager.switch_account("account-b").unwrap();
        assert!(manager
            .status()
            .unwrap()
            .accounts
            .iter()
            .all(|profile| profile.id != "account-a"));
    }

    #[test]
    fn failed_switch_does_not_record_target_activation() {
        let (_root, manager) = test_manager();
        manager
            .write_live_auth(&auth("account-a", "a@example.com", "synthetic-a"))
            .unwrap();
        manager.save_current("账号 A").unwrap();
        manager
            .write_live_auth(&auth("account-b", "b@example.com", "synthetic-b"))
            .unwrap();
        manager.save_current("账号 B").unwrap();
        fs::remove_file(manager.auth_path()).unwrap();
        fs::create_dir(manager.auth_path()).unwrap();
        assert!(manager.switch_account("account-a").is_err());
        let vault = manager.load_vault().unwrap();
        assert_eq!(vault.activations.last().unwrap().account_id, "account-b");
        let persisted: Vault = read_json(&manager.vault_path, "测试账号库").unwrap();
        assert_eq!(
            persisted.activations.last().unwrap().account_id,
            "account-b"
        );
    }

    #[test]
    fn activation_journal_recovers_only_after_auth_was_replaced() {
        let (_root, manager) = test_manager();
        let original = auth("account-a", "a@example.com", "synthetic-a");
        let next = auth("account-b", "b@example.com", "synthetic-b");
        manager.write_live_auth(&original).unwrap();
        manager.save_current("账号 A").unwrap();
        let mut vault = manager.load_vault().unwrap();
        upsert_profile(&mut vault, next.clone(), Some("账号 B")).unwrap();
        let activated_at = unix_timestamp();
        vault.pending_activation = Some(ActivationRecord {
            account_id: "account-b".into(),
            activated_at,
        });
        manager.save_vault(&vault).unwrap();
        // 模拟替换之前中断，不应声称 B 已激活。
        assert_eq!(
            manager
                .load_vault()
                .unwrap()
                .activations
                .last()
                .unwrap()
                .account_id,
            "account-a"
        );
        // 模拟替换之后、最终账号库保存之前中断。
        manager.write_live_auth(&next).unwrap();
        let recovered = manager.load_vault().unwrap();
        assert_eq!(
            recovered.activations.last().unwrap().account_id,
            "account-b"
        );
        assert_eq!(
            recovered.activations.last().unwrap().activated_at,
            activated_at
        );
        assert!(recovered.pending_activation.is_none());
        manager.save_vault(&recovered).unwrap();
        assert_eq!(
            manager.load_vault().unwrap().activations.len(),
            recovered.activations.len()
        );
    }

    #[test]
    fn local_usage_recovers_a_completed_pending_switch_without_writing_credentials() {
        tauri::async_runtime::block_on(async {
            let (_root, manager) = test_manager();
            let original = auth("account-a", "a@example.com", "synthetic-a");
            let next = auth("account-b", "b@example.com", "synthetic-b");
            manager.write_live_auth(&original).unwrap();
            manager.save_current("账号 A").unwrap();
            let mut vault = manager.load_vault().unwrap();
            let now = unix_timestamp();
            vault.activations[0].activated_at = now - 100;
            upsert_profile(&mut vault, next.clone(), Some("账号 B")).unwrap();
            vault.pending_activation = Some(ActivationRecord {
                account_id: "account-b".into(),
                activated_at: now - 10,
            });
            manager.save_vault(&vault).unwrap();
            let sessions = manager.codex_home.join("sessions");
            fs::create_dir_all(&sessions).unwrap();
            fs::write(sessions.join("session.jsonl"), format!("{}\n", json!({"timestamp":Utc::now().to_rfc3339(),"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":123}}}}))).unwrap();
            // 写 auth 之前中断：仍归 A；写 auth 之后中断：恢复 B 的原切换时间。
            for (live, expected) in [(original, "account-a"), (next, "account-b")] {
                manager.write_live_auth(&live).unwrap();
                let auth_before = fs::read(manager.auth_path()).unwrap();
                let vault_before = fs::read(&manager.vault_path).unwrap();
                let stats = manager.local_usage(&Mutex::new(())).await.unwrap();
                assert_eq!(stats.today.total_tokens, 123);
                assert_eq!(stats.by_account[0].account_id, expected);
                assert_eq!(fs::read(manager.auth_path()).unwrap(), auth_before);
                assert_eq!(fs::read(&manager.vault_path).unwrap(), vault_before);
            }
        });
    }

    #[test]
    fn failed_import_and_device_login_do_not_claim_activation() {
        for device_login in [false, true] {
            let (_root, manager) = test_manager();
            manager
                .write_live_auth(&auth("account-a", "a@example.com", "synthetic-a"))
                .unwrap();
            manager.save_current("账号 A").unwrap();
            fs::remove_file(manager.auth_path()).unwrap();
            fs::create_dir(manager.auth_path()).unwrap();
            let next = auth("account-b", "b@example.com", "synthetic-b");
            let result = if device_login {
                manager.complete_device_login(next, "账号 B")
            } else {
                manager.import_materialized_auth(next, Some("账号 B"))
            };
            assert!(result.is_err());
            assert_eq!(
                manager
                    .load_vault()
                    .unwrap()
                    .activations
                    .last()
                    .unwrap()
                    .account_id,
                "account-a"
            );
        }
    }

    #[test]
    fn failed_quota_query_still_persists_rotated_credentials() {
        let (_root, manager) = test_manager();
        let original = auth("account-a", "a@example.com", "synthetic-a");
        let rotated = auth("account-a", "a@example.com", "synthetic-rotated");
        manager.write_live_auth(&original).unwrap();
        manager.save_current("账号 A").unwrap();
        let quota = manager
            .merge_quota_outcome(QuotaOutcome {
                query_permit: None,
                profile_id: "account-a".into(),
                account_id: "account-a".into(),
                original_auth: original,
                queried_at: unix_timestamp(),
                result: Err(QuotaQueryError::Message("测试查询失败".into())),
                refreshed_auth: Some(rotated.clone()),
            })
            .unwrap()
            .unwrap();
        assert!(!quota.success);
        assert!(manager.read_live_auth().unwrap() == rotated);
        assert!(manager.load_vault().unwrap().profiles[0].auth == rotated);
    }

    #[test]
    fn rejects_rotated_credentials_for_another_account() {
        assert!(checked_refreshed_auth(
            &auth("account-b", "b@example.com", "synthetic-b"),
            "account-a"
        )
        .is_err());
    }

    #[test]
    fn atomic_replacement_preserves_destination_on_failure_and_cleans_temporary_file() {
        let root = TempDir::new().unwrap();
        let destination = root.path().join("auth.json");
        atomic_write(&destination, b"original").unwrap();
        atomic_write(&destination, b"replacement").unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"replacement");
        assert!(!destination.with_extension("cam-backup").exists());
        fs::remove_file(&destination).unwrap();
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("keep"), b"untouched").unwrap();
        assert!(atomic_write(&destination, b"replacement").is_err());
        assert_eq!(fs::read(destination.join("keep")).unwrap(), b"untouched");
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn recovers_legacy_windows_backup_without_overwriting_an_existing_file() {
        let root = TempDir::new().unwrap();
        let destination = root.path().join("auth.json");
        let backup = destination.with_extension("cam-backup");
        fs::write(&backup, b"previous").unwrap();
        recover_legacy_backup(&destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"previous");
        fs::write(&backup, b"older").unwrap();
        recover_legacy_backup(&destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"previous");
        assert_eq!(fs::read(&backup).unwrap(), b"older");
    }

    fn fake_jwt(account_id: &str, email: &str) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#);
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({
                "chatgpt_account_id": account_id,
                "email": email,
            }))
            .unwrap(),
        );
        format!("{header}.{payload}.signature")
    }

    fn auth(account_id: &str, email: &str, refresh_token: &str) -> Value {
        json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {
                "id_token": fake_jwt(account_id, email),
                "access_token": fake_jwt(account_id, email),
                "refresh_token": refresh_token,
                "account_id": account_id,
            }
        })
    }

    fn test_manager() -> (TempDir, AccountManager) {
        let root = TempDir::new().unwrap();
        let manager = AccountManager::new(root.path().join("codex"), root.path().join("app"));
        (root, manager)
    }

    fn legacy_transfer_text(manager: &AccountManager, profile_id: &str) -> String {
        let (label, auth) = manager.auth_transfer_source(profile_id).unwrap();
        auth_share::encode_legacy_text(&label, &auth).unwrap()
    }

    #[test]
    fn saves_and_switches_profiles_without_losing_rotated_tokens() {
        let (_root, manager) = test_manager();
        manager
            .write_live_auth(&auth("account-a", "a@example.com", "refresh-a"))
            .unwrap();
        manager.save_current("个人账号").unwrap();

        manager
            .write_live_auth(&auth("account-b", "b@example.com", "refresh-b"))
            .unwrap();
        manager.save_current("工作账号").unwrap();
        manager
            .write_live_auth(&auth("account-b", "b@example.com", "refresh-b-rotated"))
            .unwrap();

        manager.switch_account("account-a").unwrap();
        assert_eq!(
            manager
                .read_live_auth()
                .unwrap()
                .pointer("/tokens/account_id")
                .and_then(Value::as_str),
            Some("account-a")
        );

        manager.switch_account("account-b").unwrap();
        assert_eq!(
            manager
                .read_live_auth()
                .unwrap()
                .pointer("/tokens/refresh_token")
                .and_then(Value::as_str),
            Some("refresh-b-rotated")
        );
    }

    #[test]
    fn removes_the_active_saved_profile_without_logging_out() {
        let (_root, manager) = test_manager();
        let live_auth = auth("account-a", "a@example.com", "refresh-a");
        manager.write_live_auth(&live_auth).unwrap();
        manager.save_current("个人账号").unwrap();

        let status = manager.remove_account("account-a").unwrap();

        assert!(status.accounts.is_empty());
        assert_eq!(status.active_account_id.as_deref(), Some("account-a"));
        assert_eq!(manager.read_live_auth().unwrap(), live_auth);
    }

    #[test]
    fn imports_a_legacy_cas2_account_as_the_active_login() {
        let (_source_root, source) = test_manager();
        source
            .write_live_auth(&auth("account-a", "a@example.com", "refresh-a"))
            .unwrap();
        source.save_current("个人账号").unwrap();
        let share = legacy_transfer_text(&source, "account-a");

        let (_target_root, target) = test_manager();
        target
            .write_live_auth(&auth("account-b", "b@example.com", "refresh-b"))
            .unwrap();
        target.save_current("工作账号").unwrap();
        let seed = transfer_seed(auth_share::decode_text(&share).unwrap()).unwrap();
        let imported_auth = materialize_transferred_auth(
            seed.id_token,
            seed.account_id,
            OAuthTokenResponse {
                access_token: fake_jwt("account-a", "a@example.com"),
                refresh_token: Some("refresh-a-rotated".to_string()),
                id_token: None,
            },
        )
        .unwrap();
        let status = target
            .import_materialized_auth(imported_auth, seed.label.as_deref())
            .unwrap();

        assert_eq!(status.active_account_id.as_deref(), Some("account-a"));
        assert_eq!(status.accounts.len(), 2);
        assert_eq!(
            target
                .read_live_auth()
                .unwrap()
                .pointer("/tokens/refresh_token")
                .and_then(Value::as_str),
            Some("refresh-a-rotated")
        );
    }

    #[test]
    fn importing_an_existing_account_keeps_its_local_label() {
        let (_source_root, source) = test_manager();
        source
            .write_live_auth(&auth("account-a", "a@example.com", "refresh-from-source"))
            .unwrap();
        source.save_current("来源名称").unwrap();
        let share = legacy_transfer_text(&source, "account-a");

        let (_target_root, target) = test_manager();
        target
            .write_live_auth(&auth("account-a", "a@example.com", "refresh-from-target"))
            .unwrap();
        target.save_current("本地名称").unwrap();
        let seed = transfer_seed(auth_share::decode_text(&share).unwrap()).unwrap();
        let imported_auth = materialize_transferred_auth(
            seed.id_token,
            seed.account_id,
            OAuthTokenResponse {
                access_token: fake_jwt("account-a", "a@example.com"),
                refresh_token: Some("refresh-from-source-rotated".to_string()),
                id_token: None,
            },
        )
        .unwrap();
        let status = target
            .import_materialized_auth(imported_auth, seed.label.as_deref())
            .unwrap();

        assert_eq!(status.accounts[0].label, "本地名称");
        assert_eq!(
            target
                .read_live_auth()
                .unwrap()
                .pointer("/tokens/refresh_token")
                .and_then(Value::as_str),
            Some("refresh-from-source-rotated")
        );
    }

    #[test]
    fn legacy_cas2_strips_api_keys_and_unrelated_auth_fields() {
        let (_root, manager) = test_manager();
        let mut value = auth("account-a", "a@example.com", "refresh-a");
        value["OPENAI_API_KEY"] = Value::String("must-not-be-shared".to_string());
        value["unrelated_secret"] = Value::String("also-private".to_string());
        manager.write_live_auth(&value).unwrap();
        manager.save_current("个人账号").unwrap();

        let share = legacy_transfer_text(&manager, "account-a");
        let imported = crate::auth_share::decode_text(&share).unwrap();
        let ImportedAuth::LegacySnapshot { auth, .. } = imported else {
            panic!("CAS2 应解码为旧版快照");
        };

        assert!(auth["OPENAI_API_KEY"].is_null());
        assert!(auth.get("unrelated_secret").is_none());
    }

    #[test]
    fn persists_refreshed_transfer_in_the_vault_and_active_auth_cache() {
        let (_root, manager) = test_manager();
        manager
            .write_live_auth(&auth("account-a", "a@example.com", "refresh-a"))
            .unwrap();
        manager.save_current("个人账号").unwrap();
        let mut refreshed = auth("account-a", "a@example.com", "refresh-a-rotated");
        refreshed["last_refresh"] = Value::String("2026-08-28T00:00:00Z".to_string());

        manager
            .persist_refreshed_transfer("account-a", refreshed)
            .unwrap();

        assert_eq!(
            manager
                .read_live_auth()
                .unwrap()
                .pointer("/tokens/refresh_token")
                .and_then(Value::as_str),
            Some("refresh-a-rotated")
        );
        assert_eq!(
            manager
                .load_vault()
                .unwrap()
                .profiles
                .iter()
                .find(|profile| profile.id == "account-a")
                .unwrap()
                .auth
                .get("last_refresh")
                .and_then(Value::as_str),
            Some("2026-08-28T00:00:00Z")
        );
    }

    #[test]
    fn refreshing_an_inactive_transfer_does_not_switch_the_live_account() {
        let (_root, manager) = test_manager();
        manager
            .write_live_auth(&auth("account-a", "a@example.com", "refresh-a"))
            .unwrap();
        manager.save_current("个人账号").unwrap();
        manager
            .write_live_auth(&auth("account-b", "b@example.com", "refresh-b"))
            .unwrap();
        manager.save_current("工作账号").unwrap();

        manager
            .persist_refreshed_transfer(
                "account-a",
                auth("account-a", "a@example.com", "refresh-a-rotated"),
            )
            .unwrap();

        assert_eq!(
            manager
                .read_live_auth()
                .unwrap()
                .pointer("/tokens/account_id")
                .and_then(Value::as_str),
            Some("account-b")
        );
        let vault = manager.load_vault().unwrap();
        assert_eq!(
            vault
                .profiles
                .iter()
                .find(|profile| profile.id == "account-a")
                .unwrap()
                .auth
                .pointer("/tokens/refresh_token")
                .and_then(Value::as_str),
            Some("refresh-a-rotated")
        );
    }

    #[test]
    fn quota_refresh_updates_live_auth_after_active_profile_is_removed() {
        let (_root, manager) = test_manager();
        let original = auth("account-a", "a@example.com", "refresh-a");
        let refreshed = auth("account-a", "a@example.com", "refresh-a-rotated");
        manager.write_live_auth(&original).unwrap();
        let mut vault = Vault::default();

        let vault_changed = manager
            .persist_refreshed_quota_auth(
                &mut vault,
                "account-a",
                &original,
                &refreshed,
                Some(&original),
                Some("account-a"),
            )
            .unwrap();

        assert!(!vault_changed);
        assert!(vault.profiles.is_empty());
        assert_eq!(
            manager
                .read_live_auth()
                .unwrap()
                .pointer("/tokens/refresh_token")
                .and_then(Value::as_str),
            Some("refresh-a-rotated")
        );
    }

    #[test]
    fn quota_refresh_does_not_overwrite_a_newer_live_auth() {
        let (_root, manager) = test_manager();
        let original = auth("account-a", "a@example.com", "refresh-a");
        let newer = auth("account-a", "a@example.com", "refresh-a-newer");
        let stale_refresh = auth("account-a", "a@example.com", "refresh-a-stale");
        manager.write_live_auth(&newer).unwrap();
        let mut vault = Vault::default();
        upsert_profile(&mut vault, newer.clone(), Some("个人账号")).unwrap();

        let vault_changed = manager
            .persist_refreshed_quota_auth(
                &mut vault,
                "account-a",
                &original,
                &stale_refresh,
                Some(&newer),
                Some("account-a"),
            )
            .unwrap();

        assert!(!vault_changed);
        assert_eq!(manager.read_live_auth().unwrap(), newer);
        assert_eq!(vault.profiles[0].auth, newer);
    }

    #[test]
    fn rejects_api_key_authentication() {
        let (_root, manager) = test_manager();
        manager
            .write_live_auth(&auth("account-a", "a@example.com", "refresh-a"))
            .unwrap();
        write_json(
            &manager.auth_path(),
            &json!({"auth_mode": "apikey", "OPENAI_API_KEY": "secret"}),
        )
        .unwrap();
        let error = manager.save_current("API").unwrap_err().to_string();
        assert!(error.contains("不是 ChatGPT 订阅登录"));
    }

    #[test]
    fn blocks_explicit_keyring_storage() {
        let (_root, manager) = test_manager();
        fs::create_dir_all(&manager.codex_home).unwrap();
        fs::write(
            manager.config_path(),
            "cli_auth_credentials_store = \"keyring\"\n",
        )
        .unwrap();
        let error = manager.save_current("账号").unwrap_err().to_string();
        assert!(error.contains("keyring"));
    }

    #[test]
    fn enables_file_credential_storage_without_replacing_other_config() {
        let (_root, manager) = test_manager();
        write_config(
            &manager,
            "# keep this comment\ncli_auth_credentials_store = \"keyring\"\nmodel = \"gpt-5.6\"\n\n[features]\napps = true\n",
        );

        let status = manager.enable_file_credential_storage().unwrap();
        assert!(status.supported);
        assert_eq!(status.storage_mode, "file");

        let contents = fs::read_to_string(manager.config_path()).unwrap();
        assert!(contents.contains("# keep this comment"));
        assert!(contents.contains("model = \"gpt-5.6\""));
        assert!(contents.contains("[features]"));
        assert!(contents.contains("apps = true"));
        let config = contents.parse::<toml::Table>().unwrap();
        assert_eq!(
            config
                .get("cli_auth_credentials_store")
                .and_then(toml::Value::as_str),
            Some("file")
        );
    }

    #[test]
    fn invalid_config_is_not_replaced_when_enabling_file_storage() {
        let (_root, manager) = test_manager();
        let invalid = "model = [\n";
        write_config(&manager, invalid);

        assert!(manager.enable_file_credential_storage().is_err());
        assert_eq!(fs::read_to_string(manager.config_path()).unwrap(), invalid);
    }

    #[test]
    fn does_not_expose_unknown_credential_storage_values() {
        let (_root, manager) = test_manager();
        write_config(
            &manager,
            "cli_auth_credentials_store = \"secret-looking-custom-value\"\n",
        );

        let status = manager.status().unwrap();
        assert!(!status.supported);
        assert_eq!(status.storage_mode, "unsupported");
    }

    #[test]
    fn parses_device_poll_interval_with_safety_margin() {
        assert_eq!(parse_interval(Some(&json!(5))), 8);
        assert_eq!(parse_interval(Some(&json!("7"))), 10);
        assert_eq!(parse_interval(Some(&json!(0))), 4);
        assert_eq!(parse_interval(Some(&json!("invalid"))), 8);
        assert_eq!(parse_interval(None), 8);
    }

    #[test]
    fn materializes_codex_auth_without_exposing_tokens_to_frontend_types() {
        let value = materialize_codex_auth(OAuthTokenResponse {
            access_token: fake_jwt("account-a", "a@example.com"),
            refresh_token: Some("refresh-a".to_string()),
            id_token: Some(fake_jwt("account-a", "a@example.com")),
        })
        .unwrap();

        assert_eq!(
            value.get("auth_mode").and_then(Value::as_str),
            Some("chatgpt")
        );
        assert_eq!(
            value.pointer("/tokens/account_id").and_then(Value::as_str),
            Some("account-a")
        );
        assert!(value.get("last_refresh").and_then(Value::as_str).is_some());
    }

    #[test]
    fn rejects_auth_with_mismatched_account_id_claims() {
        let mut value = auth("account-a", "a@example.com", "refresh-a");
        value["tokens"]["access_token"] = Value::String(fake_jwt("account-b", "b@example.com"));

        let error = validate_chatgpt_auth(&value).unwrap_err().to_string();

        assert!(error.contains("账号身份不一致"));
    }

    #[test]
    fn rejects_incomplete_oauth_token_response() {
        let error = materialize_codex_auth(OAuthTokenResponse {
            access_token: fake_jwt("account-a", "a@example.com"),
            refresh_token: None,
            id_token: Some(fake_jwt("account-a", "a@example.com")),
        })
        .unwrap_err()
        .to_string();
        assert!(error.contains("refresh_token"));
    }

    #[test]
    fn materializes_a_cas3_refresh_response_as_complete_codex_auth() {
        let transferred_id_token = fake_jwt("account-a", "a@example.com");
        let value = materialize_transferred_auth(
            transferred_id_token.clone(),
            "account-a".to_string(),
            OAuthTokenResponse {
                access_token: fake_jwt("account-a", "a@example.com"),
                refresh_token: Some("refresh-a-rotated".to_string()),
                id_token: None,
            },
        )
        .unwrap();

        assert_eq!(
            value.pointer("/tokens/id_token").and_then(Value::as_str),
            Some(transferred_id_token.as_str())
        );
        assert_eq!(
            value
                .pointer("/tokens/refresh_token")
                .and_then(Value::as_str),
            Some("refresh-a-rotated")
        );
        assert_eq!(
            value.pointer("/tokens/account_id").and_then(Value::as_str),
            Some("account-a")
        );
        assert!(value.get("last_refresh").and_then(Value::as_str).is_some());
    }

    #[test]
    fn rejects_a_cas3_refresh_response_for_another_account() {
        let error = materialize_transferred_auth(
            fake_jwt("account-a", "a@example.com"),
            "account-a".to_string(),
            OAuthTokenResponse {
                access_token: fake_jwt("account-b", "b@example.com"),
                refresh_token: Some("refresh-b-rotated".to_string()),
                id_token: None,
            },
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("迁移账号不一致"));
    }

    #[test]
    fn rejects_a_transfer_when_refreshed_identity_cannot_be_verified() {
        let error = materialize_transferred_auth(
            fake_jwt("account-a", "a@example.com"),
            "account-a".to_string(),
            OAuthTokenResponse {
                access_token: "opaque-access-token".to_string(),
                refresh_token: Some("refresh-a-rotated".to_string()),
                id_token: None,
            },
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("无法识别 ChatGPT 账号 ID"));
    }

    #[test]
    fn rejects_a_legacy_transfer_with_mismatched_account_identity() {
        let mut legacy_auth = auth("account-a", "a@example.com", "refresh-a");
        legacy_auth["tokens"]["account_id"] = Value::String("account-b".to_string());

        let error = transfer_seed(ImportedAuth::LegacySnapshot {
            label: "个人账号".to_string(),
            auth: legacy_auth,
        })
        .unwrap_err()
        .to_string();

        assert!(error.contains("账号身份不一致"));
    }

    #[test]
    fn cas3_import_uses_the_account_email_as_the_default_label() {
        let (_root, manager) = test_manager();
        let status = manager
            .import_materialized_auth(auth("account-a", "a@example.com", "refresh-a"), None)
            .unwrap();

        assert_eq!(status.accounts[0].label, "a@example.com");
    }

    #[test]
    fn unchanged_profile_is_not_marked_for_persistence() {
        let mut vault = Vault::default();
        let account_auth = auth("account-a", "a@example.com", "refresh-a");

        assert!(upsert_profile(&mut vault, account_auth.clone(), Some("个人账号")).unwrap());
        let updated_at = vault.profiles[0].updated_at;
        assert!(!upsert_profile(&mut vault, account_auth, None).unwrap());
        assert_eq!(vault.profiles[0].updated_at, updated_at);
    }

    #[test]
    fn records_only_real_account_switches() {
        let mut vault = Vault::default();
        assert!(record_activation(&mut vault, "account-a", 10));
        assert!(!record_activation(&mut vault, "account-a", 20));
        assert!(record_activation(&mut vault, "account-b", 30));

        assert_eq!(vault.activations.len(), 2);
        assert_eq!(vault.activations[0].activated_at, 10);
        assert_eq!(vault.activations[1].account_id, "account-b");
    }

    #[test]
    fn parses_quota_windows_without_assuming_their_presence() {
        let response: CodexUsageResponse = serde_json::from_value(json!({
            "rate_limit": {
                "primary_window": {
                    "used_percent": 37.5,
                    "limit_window_seconds": 18000,
                    "reset_at": 1787533200
                },
                "secondary_window": null
            },
            "rate_limit_reset_credits": {
                "available_count": 2
            }
        }))
        .unwrap();
        assert_eq!(
            response
                .rate_limit_reset_credits
                .as_ref()
                .and_then(|credits| credits.available_count),
            Some(2)
        );
        let rate_limit = response.rate_limit.unwrap();
        let primary = to_usage_window(rate_limit.primary_window.unwrap()).unwrap();

        assert_eq!(primary.used_percent, 37.5);
        assert_eq!(primary.window_minutes, Some(300));
        assert_eq!(primary.resets_at, Some(1787533200));
        assert!(rate_limit.secondary_window.is_none());
    }

    #[test]
    fn parses_retry_after_and_falls_back_for_invalid_values() {
        let now = chrono::DateTime::parse_from_rfc3339("2015-10-21T07:27:56Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            quota_retry_delay_value(Some("3"), "account-a", now),
            Some(Duration::from_secs(3))
        );
        assert_eq!(
            quota_retry_delay_value(Some("Wed, 21 Oct 2015 07:28:00 GMT"), "account-a", now,),
            Some(Duration::from_secs(4))
        );
        assert_eq!(
            quota_retry_delay_value(Some("invalid"), "account-a", now),
            Some(default_quota_retry_delay("account-a"))
        );
        assert_eq!(quota_retry_delay_value(Some("30"), "account-a", now), None);
    }

    #[test]
    fn maps_official_multi_bucket_quota_and_usage_summary() {
        let snapshot = codex_app_server::AccountSnapshot {
            plan_type: Some("pro".to_string()),
            rate_limits: codex_app_server::RateLimitsResponse {
                rate_limits: codex_app_server::RateLimitSnapshot {
                    limit_id: Some("codex".to_string()),
                    primary: Some(codex_app_server::RateLimitWindow {
                        used_percent: 21.0,
                        window_duration_mins: Some(10_080),
                        resets_at: Some(1_788_749_509),
                    }),
                    plan_type: Some("pro".to_string()),
                    ..Default::default()
                },
                rate_limits_by_limit_id: Some(HashMap::from([(
                    "codex_model".to_string(),
                    codex_app_server::RateLimitSnapshot {
                        limit_id: Some("codex_model".to_string()),
                        limit_name: Some("Model quota".to_string()),
                        primary: Some(codex_app_server::RateLimitWindow {
                            used_percent: 8.0,
                            window_duration_mins: Some(300),
                            resets_at: Some(1_788_364_857),
                        }),
                        ..Default::default()
                    },
                )])),
                rate_limit_reset_credits: None,
                account_id: Some("account-a".to_string()),
            },
            usage: Some(codex_app_server::AccountUsage {
                summary: codex_app_server::AccountUsageSummary {
                    lifetime_tokens: Some(1_234_567),
                    peak_daily_tokens: Some(45_678),
                    longest_running_turn_sec: Some(540),
                    current_streak_days: Some(8),
                    longest_streak_days: Some(14),
                },
                daily_usage_buckets: vec![codex_app_server::AccountUsageDailyBucket {
                    start_date: "2026-09-01".to_string(),
                    tokens: 45_678,
                }],
            }),
        };

        let details = official_quota_details(snapshot);
        assert_eq!(details.source, "appServer");
        assert_eq!(details.plan_type.as_deref(), Some("pro"));
        assert_eq!(details.buckets.len(), 2);
        assert_eq!(details.buckets[0].id, "codex");
        assert_eq!(details.buckets[1].name.as_deref(), Some("Model quota"));
        assert_eq!(details.primary.unwrap().used_percent, 21.0);
        let official_usage = details.official_usage.unwrap();
        assert_eq!(official_usage.longest_streak_days, Some(14));
        assert_eq!(official_usage.daily_usage_buckets.len(), 1);
        assert_eq!(official_usage.daily_usage_buckets[0].tokens, 45_678);
    }

    #[test]
    fn parses_available_reset_credit_expirations_without_exposing_credit_details() {
        let response: CodexResetCreditsResponse = serde_json::from_value(json!({
            "credits": [
                {
                    "status": "available",
                    "is_supported_by_plan": true,
                    "expires_at": "2026-09-21T08:11:48Z"
                },
                {
                    "status": "redeemed",
                    "is_supported_by_plan": true,
                    "expires_at": "2026-09-01T08:11:48Z"
                },
                {
                    "status": "available",
                    "is_supported_by_plan": false,
                    "expires_at": "2026-09-02T08:11:48Z"
                }
            ],
            "available_count": 1
        }))
        .unwrap();
        let credits = to_usage_reset_credits(response, Some(3));

        assert_eq!(credits.available_count, 1);
        assert_eq!(credits.expires_at, vec![1_789_978_308]);
    }

    #[cfg(unix)]
    #[test]
    fn credential_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let (_root, manager) = test_manager();
        manager
            .write_live_auth(&auth("account-a", "a@example.com", "refresh-a"))
            .unwrap();
        let mode = fs::metadata(manager.auth_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    fn write_config(manager: &AccountManager, contents: &str) {
        fs::create_dir_all(manager.codex_home_path()).unwrap();
        fs::write(manager.config_path(), contents).unwrap();
    }

    #[test]
    fn one_million_context_preset_preserves_the_rest_of_config() {
        let (_root, manager) = test_manager();
        write_config(
            &manager,
            "# keep this comment\nmodel = \"gpt-5.6\"\n\n[features]\napps = true\n",
        );

        let state = manager
            .set_codex_context_mode(CodexContextMode::OneMillion)
            .unwrap();
        assert_eq!(state.mode, "oneMillion");
        assert_eq!(state.context_window, Some(1_000_000));
        assert_eq!(state.auto_compact_token_limit, Some(900_000));

        let contents = fs::read_to_string(manager.config_path()).unwrap();
        assert!(contents.contains("# keep this comment"));
        assert!(contents.contains("model = \"gpt-5.6\""));
        assert!(contents.contains("[features]"));
        assert!(contents.contains("apps = true"));
        let config = contents.parse::<toml::Table>().unwrap();
        assert_eq!(
            config
                .get("model_context_window")
                .and_then(toml::Value::as_integer),
            Some(1_000_000)
        );
        assert_eq!(
            config
                .get("model_auto_compact_token_limit")
                .and_then(toml::Value::as_integer),
            Some(900_000)
        );
    }

    #[test]
    fn default_context_removes_only_the_context_overrides() {
        let (_root, manager) = test_manager();
        write_config(
            &manager,
            "model_context_window = 800000\nmodel_auto_compact_token_limit = 700000\nmodel_reasoning_effort = \"high\"\n",
        );

        let before = manager.codex_managed_config().unwrap().context;
        assert_eq!(before.mode, "custom");
        let state = manager
            .set_codex_context_mode(CodexContextMode::Default)
            .unwrap();
        assert_eq!(state.mode, "default");

        let contents = fs::read_to_string(manager.config_path()).unwrap();
        assert!(!contents.contains("model_context_window"));
        assert!(!contents.contains("model_auto_compact_token_limit"));
        assert!(contents.contains("model_reasoning_effort = \"high\""));
    }

    #[test]
    fn invalid_config_is_not_replaced_by_context_preset() {
        let (_root, manager) = test_manager();
        let invalid = "model = [\n";
        write_config(&manager, invalid);

        assert!(manager
            .set_codex_context_mode(CodexContextMode::OneMillion)
            .is_err());
        assert_eq!(fs::read_to_string(manager.config_path()).unwrap(), invalid);
    }

    #[test]
    fn parses_only_allowlisted_managed_config_values() {
        let (_root, manager) = test_manager();
        write_config(
            &manager,
            "cli_auth_credentials_store = \"file\"\nmodel_reasoning_effort = \"high\"\nmodel_reasoning_summary = \"unexpected-secret-like-value\"\nmodel_verbosity = \"low\"\nweb_search = \"cached\"\n",
        );

        let state = manager.codex_managed_config().unwrap();
        assert_eq!(state.credential_storage.value, "file");
        assert_eq!(state.reasoning_effort.value, "high");
        assert_eq!(state.reasoning_summary.value, "custom");
        assert_eq!(state.model_verbosity.value, "low");
        assert_eq!(state.web_search.value, "cached");
        let serialized = serde_json::to_string(&state).unwrap();
        assert!(!serialized.contains("unexpected-secret-like-value"));
    }

    #[test]
    fn updates_one_managed_config_choice_and_preserves_the_rest() {
        let (_root, manager) = test_manager();
        write_config(
            &manager,
            "# keep this comment\nmodel = \"gpt-5.6\"\nmodel_reasoning_effort = \"low\"\n\n[features]\napps = true\n",
        );

        let state = manager
            .set_codex_config_choice(CodexConfigKey::ReasoningEffort, "xhigh")
            .unwrap();
        assert_eq!(state.reasoning_effort.value, "xhigh");
        let contents = fs::read_to_string(manager.config_path()).unwrap();
        assert!(contents.contains("# keep this comment"));
        assert!(contents.contains("model = \"gpt-5.6\""));
        assert!(contents.contains("apps = true"));
        assert!(contents.contains("model_reasoning_effort = \"xhigh\""));

        manager
            .set_codex_config_choice(CodexConfigKey::ReasoningEffort, "default")
            .unwrap();
        let contents = fs::read_to_string(manager.config_path()).unwrap();
        assert!(!contents.contains("model_reasoning_effort"));
        assert!(contents.contains("model = \"gpt-5.6\""));
    }

    #[test]
    fn rejects_a_value_for_the_wrong_managed_config_key() {
        let (_root, manager) = test_manager();
        write_config(&manager, "model_reasoning_effort = \"low\"\n");
        let before = fs::read_to_string(manager.config_path()).unwrap();

        assert!(manager
            .set_codex_config_choice(CodexConfigKey::ReasoningEffort, "live")
            .is_err());
        assert_eq!(fs::read_to_string(manager.config_path()).unwrap(), before);
    }

    // OpenAI 默认提供方的 id 就是 openai，第三方按 provider id 单独成桶。
    #[test]
    fn openai_provider_maps_to_default_provider() {
        let (_root, manager) = test_manager();
        write_config(
            &manager,
            "cli_auth_credentials_store = \"file\"\nmodel_provider = \"openai\"\n",
        );

        let state = manager.model_provider_state().unwrap();
        assert_eq!(state.active_id, "openai");
        assert_eq!(state.active_provider.as_deref(), Some("openai"));
    }

    // 第三方 provider 必须能分辨彼此，不能压成一个「第三方」桶。
    #[test]
    fn third_party_providers_get_distinct_usage_ids() {
        let (_root, manager) = test_manager();
        write_config(
            &manager,
            "cli_auth_credentials_store = \"file\"\nmodel_provider = \"custom\"\n\
             [model_providers.custom]\nname = \"Local Relay\"\nbase_url = \"https://relay.example.com/v1\"\n\
             [model_providers.relay]\nname = \"Relay\"\n",
        );

        let state = manager.model_provider_state().unwrap();
        assert_eq!(state.active_id, "provider:custom");
        let labels = state
            .providers
            .iter()
            .map(|provider| (provider.id.as_str(), provider.label.as_str()))
            .collect::<Vec<_>>();
        assert!(labels.contains(&("provider:custom", "Local Relay")));
        assert!(labels.contains(&("provider:relay", "Relay")));
    }

    // 没有登记 name 时退化为 provider id，避免界面出现空白标签。
    #[test]
    fn unnamed_provider_falls_back_to_id() {
        let (_root, manager) = test_manager();
        write_config(
            &manager,
            "cli_auth_credentials_store = \"file\"\nmodel_provider = \"custom\"\n\
             [model_providers.custom]\nbase_url = \"http://127.0.0.1:8080/v1\"\n",
        );

        let state = manager.model_provider_state().unwrap();
        let custom = state
            .providers
            .iter()
            .find(|provider| provider.id == "provider:custom")
            .expect("custom provider");
        assert_eq!(custom.label, "custom");
    }
}
