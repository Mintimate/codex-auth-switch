use crate::{
    auth_share::{self, ImportedAuth},
    codex_app_server,
    usage::{
        provider_label, scan_local_usage, AccountLabel, ActivationRecord, LocalUsageStats,
        ModelProviderKind, ModelProviderOption, ModelProviderState, ProviderCatalog,
    },
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use futures_util::future::{join, join_all};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fmt,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;
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
const USAGE_QUERY_TIMEOUT_SECS: u64 = 10;
const MAX_ACTIVATION_RECORDS: usize = 10_000;
const MAX_CONCURRENT_QUOTA_QUERIES: usize = 2;
const ONE_MILLION_CONTEXT_WINDOW: i64 = 1_000_000;
const ONE_MILLION_AUTO_COMPACT_LIMIT: i64 = 900_000;

// reqwest 的 Client 内部持有连接池，每次请求重建意味着重新 DNS + TCP + TLS 握手。
// 设备登录轮询每 5-8 秒一次，复用客户端才能保住连接。
// 额度查询单独用一个带超时的客户端，OAuth 流程保持无超时（令牌刷新不能被 10 秒掐断）。
static OAUTH_CLIENT: OnceLock<Client> = OnceLock::new();
static QUOTA_CLIENT: OnceLock<Client> = OnceLock::new();

#[derive(Debug)]
pub enum ManagerError {
    Io(String),
    InvalidConfig(String),
    UnsupportedStorage(String),
    InvalidAuth(String),
    ProfileNotFound,
    Network(String),
    DeviceCodeExpired,
    TokenExchange(String),
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexContextMode {
    Default,
    OneMillion,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexContextConfig {
    mode: String,
    context_window: Option<i64>,
    auto_compact_token_limit: Option<i64>,
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
    index: usize,
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
                upsert_profile(&mut vault, current_auth, None)?;
            }
        }

        let target = vault
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .cloned()
            .ok_or(ManagerError::ProfileNotFound)?;

        record_activation(&mut vault, &target.account_id, unix_timestamp());
        self.save_vault(&vault)?;
        self.write_live_auth(&target.auth)?;
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
                upsert_profile(&mut vault, current_auth, None)?;
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
                upsert_profile(&mut vault, current_auth, None)?;
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
        record_activation(&mut vault, &identity.account_id, unix_timestamp());
        self.save_vault(&vault)?;
        self.write_live_auth(&auth)?;
        self.status()
    }

    pub async fn start_device_login(
        &self,
        label: &str,
    ) -> Result<DeviceLoginResponse, ManagerError> {
        self.ensure_file_storage()?;
        validate_label(label)?;

        let response = oauth_client()
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

    pub async fn poll_device_login(
        &self,
        device_code: &str,
        user_code: &str,
        label: &str,
    ) -> Result<Option<AppStatus>, ManagerError> {
        self.ensure_file_storage()?;
        let label = validate_label(label)?.to_string();
        if device_code.trim().is_empty() || user_code.trim().is_empty() {
            return Err(ManagerError::InvalidConfig(
                "登录验证码状态无效，请重新发起登录".to_string(),
            ));
        }

        let response = oauth_client()
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

        let mut vault = self.load_vault()?;
        if let Ok(current_auth) = self.read_live_auth() {
            if validate_chatgpt_auth(&current_auth).is_ok() {
                upsert_profile(&mut vault, current_auth, None)?;
            }
        }
        upsert_profile(&mut vault, auth.clone(), Some(&label))?;
        let identity = validate_chatgpt_auth(&auth)?;
        record_activation(&mut vault, &identity.account_id, unix_timestamp());
        self.save_vault(&vault)?;
        self.write_live_auth(&auth)?;
        self.status().map(Some)
    }

    pub async fn account_quotas(&self) -> Result<Vec<AccountQuota>, ManagerError> {
        let (mut vault, active_account_id) = self.load_usage_vault()?;

        // 先把要查询的凭据取成快照，避免并发任务借用 vault 而锁住后面的回写。
        let quota_targets = vault
            .profiles
            .iter()
            .map(|profile| (profile.account_id.clone(), profile.auth.clone()))
            .collect::<Vec<_>>();

        let outcomes = {
            let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_QUOTA_QUERIES));
            let tasks = quota_targets
                .into_iter()
                .enumerate()
                .map(|(index, (account_id, auth))| {
                    let semaphore = Arc::clone(&semaphore);
                    async move {
                        // acquire_owned 让 permit 自持 Arc，避免 permit 借用外层局部变量的生命周期问题。
                        let Ok(_permit) = semaphore.acquire_owned().await else {
                            return QuotaOutcome {
                                index,
                                queried_at: unix_timestamp(),
                                result: Err(QuotaQueryError::Message(
                                    "额度查询并发控制不可用".to_string(),
                                )),
                                refreshed_auth: None,
                            };
                        };
                        let queried_at = unix_timestamp();
                        let (result, refreshed_auth) =
                            query_account_details(&auth, &account_id).await;

                        QuotaOutcome {
                            index,
                            queried_at,
                            result,
                            refreshed_auth,
                        }
                    }
                });
            join_all(tasks).await
        };

        let mut quotas = Vec::with_capacity(outcomes.len());
        let mut vault_changed = false;
        for outcome in outcomes {
            let QuotaOutcome {
                index,
                queried_at,
                result,
                refreshed_auth,
            } = outcome;

            if let Some(auth) = refreshed_auth {
                let profile = vault
                    .profiles
                    .get_mut(index)
                    .ok_or(ManagerError::ProfileNotFound)?;
                let account_id = profile.account_id.clone();
                profile.auth = auth.clone();
                profile.updated_at = unix_timestamp();
                vault_changed = true;
                if active_account_id.as_deref() == Some(account_id.as_str()) {
                    self.write_live_auth(&auth)?;
                }
            }

            let profile = vault
                .profiles
                .get(index)
                .ok_or(ManagerError::ProfileNotFound)?;
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
            quotas.push(quota);
        }
        if vault_changed {
            self.save_vault(&vault)?;
        }

        Ok(quotas)
    }

    pub async fn local_usage(&self) -> Result<LocalUsageStats, ManagerError> {
        let (vault, _) = self.load_usage_vault()?;
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
        tauri::async_runtime::spawn_blocking(move || {
            scan_local_usage(&codex_home, &activations, &accounts, &catalog)
        })
        .await
        .map_err(|error| ManagerError::Io(format!("读取本地会话用量失败: {error}")))
    }

    fn load_usage_vault(&self) -> Result<(Vault, Option<String>), ManagerError> {
        self.ensure_file_storage()?;
        let mut vault = self.load_vault()?;
        let mut vault_changed = false;
        let active_account_id = if let Ok(auth) = self.read_live_auth() {
            if let Ok(identity) = validate_chatgpt_auth(&auth) {
                vault_changed |= upsert_profile(&mut vault, auth, None)?;
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

    pub fn codex_context_config(&self) -> Result<CodexContextConfig, ManagerError> {
        let config_path = self.config_path();
        if !config_path.exists() {
            return Ok(context_config_state(None, None));
        }
        let contents = fs::read_to_string(&config_path).map_err(|error| {
            ManagerError::Io(format!("读取 {} 失败: {error}", config_path.display()))
        })?;
        if contents.trim().is_empty() {
            return Ok(context_config_state(None, None));
        }
        let document = contents.parse::<DocumentMut>().map_err(|error| {
            ManagerError::InvalidConfig(format!("Codex config.toml 格式错误: {error}"))
        })?;
        Ok(context_config_state(
            document
                .get("model_context_window")
                .and_then(|item| item.as_integer()),
            document
                .get("model_auto_compact_token_limit")
                .and_then(|item| item.as_integer()),
        ))
    }

    pub fn set_codex_context_mode(
        &self,
        mode: CodexContextMode,
    ) -> Result<CodexContextConfig, ManagerError> {
        let config_path = self.config_path();
        let contents = if config_path.exists() {
            fs::read_to_string(&config_path).map_err(|error| {
                ManagerError::Io(format!("读取 {} 失败: {error}", config_path.display()))
            })?
        } else {
            String::new()
        };
        let mut document = contents.parse::<DocumentMut>().map_err(|error| {
            ManagerError::InvalidConfig(format!("Codex config.toml 格式错误: {error}"))
        })?;

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

        atomic_write(&config_path, document.to_string().as_bytes())?;
        self.codex_context_config()
    }

    fn storage_mode(&self) -> Result<String, ManagerError> {
        let config_path = self.config_path();
        if !config_path.exists() {
            return Ok("file".to_string());
        }
        let contents = fs::read_to_string(&config_path).map_err(|error| {
            ManagerError::Io(format!("读取 {} 失败: {error}", config_path.display()))
        })?;
        if contents.trim().is_empty() {
            return Ok("file".to_string());
        }
        let config = contents.parse::<toml::Table>().map_err(|error| {
            ManagerError::InvalidConfig(format!("Codex config.toml 格式错误: {error}"))
        })?;
        Ok(config
            .get("cli_auth_credentials_store")
            .and_then(toml::Value::as_str)
            .unwrap_or("file")
            .to_ascii_lowercase())
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
        self.ensure_file_storage()?;
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
        if !self.vault_path.exists() {
            return Ok(Vault::default());
        }
        let vault = read_json::<Vault>(&self.vault_path, "本地账号库")?;
        if vault.version != VAULT_VERSION {
            return Err(ManagerError::InvalidConfig(format!(
                "不支持的账号库版本 {}",
                vault.version
            )));
        }
        Ok(vault)
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
    let account_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
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
    claims
        .chatgpt_account_id
        .clone()
        .or_else(|| {
            claims
                .openai_auth
                .as_ref()
                .and_then(|auth| auth.chatgpt_account_id.clone())
        })
        .or_else(|| {
            claims
                .organizations
                .first()
                .and_then(|organization| organization.id.clone())
        })
}

async fn query_account_details(
    auth: &Value,
    account_id: &str,
) -> (QuotaQueryResult, Option<Value>) {
    if let Ok(snapshot) = codex_app_server::query_account(auth).await {
        if snapshot
            .rate_limits
            .account_id
            .as_deref()
            .is_some_and(|response_id| response_id != account_id)
        {
            return (
                Err(QuotaQueryError::Message(
                    "官方账户响应与本地账号不一致，请重新登录".to_string(),
                )),
                None,
            );
        }
        let refreshed_auth = match snapshot.refreshed_auth.as_ref() {
            Some(auth) => match canonical_chatgpt_auth(auth).and_then(|auth| {
                let identity = validate_chatgpt_auth(&auth)?;
                if identity.account_id != account_id {
                    return Err(ManagerError::InvalidAuth(
                        "官方账户响应与本地账号不一致，请重新登录".to_string(),
                    ));
                }
                Ok(auth)
            }) {
                Ok(auth) => Some(auth),
                Err(error) => return (Err(QuotaQueryError::Message(error.to_string())), None),
            },
            None => None,
        };
        return (Ok(official_quota_details(snapshot)), refreshed_auth);
    }

    let mut result = query_account_quota_compatibility(auth, account_id).await;
    let mut refreshed_auth = None;
    if matches!(result, Err(QuotaQueryError::Unauthorized)) {
        match refresh_codex_auth(auth).await {
            Ok(next_auth) => {
                result = query_account_quota_compatibility(&next_auth, account_id).await;
                refreshed_auth = Some(next_auth);
            }
            Err(error) => result = Err(QuotaQueryError::Message(error.to_string())),
        }
    }
    (result, refreshed_auth)
}

fn official_quota_details(snapshot: codex_app_server::AccountSnapshot) -> QuotaDetails {
    let codex_app_server::AccountSnapshot {
        plan_type,
        rate_limits,
        usage,
        refreshed_auth: _,
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
    let (usage, reset_credits) = join(
        query_usage_windows(client, access_token, account_id),
        query_reset_credits(client, access_token, account_id),
    )
    .await;
    let (primary, secondary, available_count) = usage?;
    let reset_credits = match reset_credits {
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

async fn query_usage_windows(
    client: &Client,
    access_token: &str,
    account_id: &str,
) -> Result<(Option<UsageWindow>, Option<UsageWindow>, Option<u64>), QuotaQueryError> {
    let response = client
        .get(CODEX_USAGE_URL)
        .bearer_auth(access_token)
        .header("Accept", "application/json")
        .header("ChatGPT-Account-Id", account_id)
        .send()
        .await
        .map_err(|error| {
            let message = if error.is_timeout() {
                "额度查询超时"
            } else if error.is_connect() {
                "无法连接额度服务"
            } else {
                "额度查询网络失败"
            };
            QuotaQueryError::Message(message.to_string())
        })?;

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
    let response = client
        .get(CODEX_RESET_CREDITS_URL)
        .bearer_auth(access_token)
        .header("Accept", "application/json")
        .header("ChatGPT-Account-Id", account_id)
        .send()
        .await
        .map_err(|error| {
            let message = if error.is_timeout() {
                "重置额度查询超时"
            } else if error.is_connect() {
                "无法连接重置额度服务"
            } else {
                "重置额度查询网络失败"
            };
            QuotaQueryError::Message(message.to_string())
        })?;

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
    let response = oauth_client()
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

fn oauth_client() -> &'static Client {
    OAUTH_CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(USER_AGENT)
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

fn quota_client() -> Result<&'static Client, QuotaQueryError> {
    if let Some(client) = QUOTA_CLIENT.get() {
        return Ok(client);
    }
    let client = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(USAGE_QUERY_TIMEOUT_SECS))
        .build()
        .map_err(|_| QuotaQueryError::Message("无法初始化额度查询".to_string()))?;
    // 并发首次调用可能各建一个客户端，OnceLock 只保留第一个，多余的实例会被安全丢弃。
    Ok(QUOTA_CLIENT.get_or_init(|| client))
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
    let response = oauth_client()
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
    let contents = fs::read(path).map_err(|error| {
        ManagerError::Io(format!(
            "读取 {description}（{}）失败: {error}",
            path.display()
        ))
    })?;
    serde_json::from_slice(&contents)
        .map_err(|error| ManagerError::InvalidAuth(format!("{description} 格式错误: {error}")))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), ManagerError> {
    let mut contents = serde_json::to_vec_pretty(value)
        .map_err(|error| ManagerError::Io(format!("序列化认证数据失败: {error}")))?;
    contents.push(b'\n');
    atomic_write(path, &contents)
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<(), ManagerError> {
    let parent = path
        .parent()
        .ok_or_else(|| ManagerError::Io(format!("无法定位 {} 的父目录", path.display())))?;
    fs::create_dir_all(parent).map_err(|error| {
        ManagerError::Io(format!("创建目录 {} 失败: {error}", parent.display()))
    })?;
    secure_directory(parent)?;

    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("credentials");
    let temporary = parent.join(format!(
        ".{file_name}.cam-{}-{suffix}.tmp",
        std::process::id()
    ));
    let result = (|| {
        let mut file = open_secure_file(&temporary)?;
        file.write_all(contents)
            .map_err(|error| ManagerError::Io(format!("写入临时认证文件失败: {error}")))?;
        file.sync_all()
            .map_err(|error| ManagerError::Io(format!("同步临时认证文件失败: {error}")))?;
        replace_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn open_secure_file(path: &Path) -> Result<File, ManagerError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| ManagerError::Io(format!("创建临时认证文件失败: {error}")))
}

#[cfg(unix)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), ManagerError> {
    fs::rename(source, destination).map_err(|error| {
        ManagerError::Io(format!("原子替换 {} 失败: {error}", destination.display()))
    })
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), ManagerError> {
    let backup = destination.with_extension("cam-backup");
    if backup.exists() {
        fs::remove_file(&backup)
            .map_err(|error| ManagerError::Io(format!("清理旧认证备份失败: {error}")))?;
    }
    if destination.exists() {
        fs::rename(destination, &backup)
            .map_err(|error| ManagerError::Io(format!("创建认证备份失败: {error}")))?;
    }
    if let Err(error) = fs::rename(source, destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, destination);
        }
        return Err(ManagerError::Io(format!("替换认证文件失败: {error}")));
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
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
            refreshed_auth: None,
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

        let before = manager.codex_context_config().unwrap();
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
