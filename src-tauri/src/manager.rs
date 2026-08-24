use crate::usage::{scan_local_usage, AccountLabel, ActivationRecord, LocalUsageStats};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fmt,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const VAULT_VERSION: u32 = 1;
const VAULT_FILE_NAME: &str = "accounts.v1.json";
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_AUTH_USERCODE_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_AUTH_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
const OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const DEVICE_VERIFICATION_URL: &str = "https://auth.openai.com/codex/device";
const DEVICE_REDIRECT_URI: &str = "https://auth.openai.com/deviceauth/callback";
const DEVICE_CODE_DEFAULT_EXPIRES_IN: u64 = 900;
const POLLING_SAFETY_MARGIN_SECS: u64 = 3;
const USER_AGENT: &str = "codex-auth-switch";
const USAGE_QUERY_TIMEOUT_SECS: u64 = 10;
const MAX_ACTIVATION_RECORDS: usize = 10_000;

#[derive(Debug)]
pub enum ManagerError {
    Io(String),
    InvalidConfig(String),
    UnsupportedStorage(String),
    InvalidAuth(String),
    ProfileNotFound,
    ActiveProfileRemoval,
    Network(String),
    DeviceCodeExpired,
    TokenExchange(String),
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
            Self::ActiveProfileRemoval => {
                formatter.write_str("不能移除当前正在使用的账号，请先切换到其他账号")
            }
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
pub struct AccountQuota {
    pub profile_id: String,
    pub account_id: String,
    pub label: String,
    pub primary: Option<UsageWindow>,
    pub secondary: Option<UsageWindow>,
    pub success: bool,
    pub error: Option<String>,
    pub queried_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageOverview {
    pub quotas: Vec<AccountQuota>,
    pub local: LocalUsageStats,
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
struct CodexUsageResponse {
    rate_limit: Option<CodexRateLimit>,
}

enum QuotaQueryError {
    Unauthorized,
    Message(String),
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
}

impl Default for Vault {
    fn default() -> Self {
        Self {
            version: VAULT_VERSION,
            profiles: Vec::new(),
            activations: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
struct AuthIdentity {
    account_id: String,
    email: Option<String>,
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
        let active_account_id = self
            .read_live_auth()
            .ok()
            .and_then(|auth| validate_chatgpt_auth(&auth).ok())
            .map(|identity| identity.account_id);
        let mut vault = self.load_vault()?;
        let profile = vault
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .ok_or(ManagerError::ProfileNotFound)?;
        if active_account_id.as_deref() == Some(profile.account_id.as_str()) {
            return Err(ManagerError::ActiveProfileRemoval);
        }
        vault.profiles.retain(|profile| profile.id != profile_id);
        self.save_vault(&vault)?;
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

    pub async fn usage_overview(&self) -> Result<UsageOverview, ManagerError> {
        self.ensure_file_storage()?;
        let mut vault = self.load_vault()?;
        let active_account_id = self.read_live_auth().ok().and_then(|auth| {
            let identity = validate_chatgpt_auth(&auth).ok()?;
            upsert_profile(&mut vault, auth, None).ok()?;
            Some(identity.account_id)
        });
        if let Some(account_id) = active_account_id.as_deref() {
            record_activation(&mut vault, account_id, unix_timestamp());
        }
        self.save_vault(&vault)?;

        let mut quotas = Vec::with_capacity(vault.profiles.len());
        let mut vault_changed = false;
        for index in 0..vault.profiles.len() {
            let profile = vault.profiles[index].clone();
            let queried_at = unix_timestamp();
            let mut result = query_account_quota(&profile.auth, &profile.account_id).await;

            if matches!(result, Err(QuotaQueryError::Unauthorized)) {
                match refresh_codex_auth(&profile.auth).await {
                    Ok(refreshed_auth) => {
                        vault.profiles[index].auth = refreshed_auth.clone();
                        vault.profiles[index].updated_at = unix_timestamp();
                        vault_changed = true;
                        if active_account_id.as_deref() == Some(profile.account_id.as_str()) {
                            self.write_live_auth(&refreshed_auth)?;
                        }
                        result = query_account_quota(&refreshed_auth, &profile.account_id).await;
                    }
                    Err(error) => result = Err(QuotaQueryError::Message(error.to_string())),
                }
            }

            let quota = match result {
                Ok((primary, secondary)) => AccountQuota {
                    profile_id: profile.id,
                    account_id: profile.account_id,
                    label: profile.label,
                    primary,
                    secondary,
                    success: true,
                    error: None,
                    queried_at,
                },
                Err(QuotaQueryError::Unauthorized) => AccountQuota {
                    profile_id: profile.id,
                    account_id: profile.account_id,
                    label: profile.label,
                    primary: None,
                    secondary: None,
                    success: false,
                    error: Some("订阅凭据已失效，请重新登录该账号".to_string()),
                    queried_at,
                },
                Err(QuotaQueryError::Message(message)) => AccountQuota {
                    profile_id: profile.id,
                    account_id: profile.account_id,
                    label: profile.label,
                    primary: None,
                    secondary: None,
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

        let accounts = vault
            .profiles
            .iter()
            .map(|profile| AccountLabel {
                account_id: profile.account_id.clone(),
                label: profile.label.clone(),
            })
            .collect::<Vec<_>>();
        let local = scan_local_usage(&self.codex_home, &vault.activations, &accounts);
        Ok(UsageOverview { quotas, local })
    }

    fn auth_path(&self) -> PathBuf {
        self.codex_home.join("auth.json")
    }

    fn config_path(&self) -> PathBuf {
        self.codex_home.join("config.toml")
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

fn upsert_profile(vault: &mut Vault, auth: Value, label: Option<&str>) -> Result<(), ManagerError> {
    let identity = validate_chatgpt_auth(&auth)?;
    let now = unix_timestamp();
    if let Some(profile) = vault
        .profiles
        .iter_mut()
        .find(|profile| profile.account_id == identity.account_id)
    {
        if let Some(label) = label {
            profile.label = label.to_string();
        }
        profile.email = identity.email;
        profile.auth = auth;
        profile.updated_at = now;
        return Ok(());
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
    Ok(())
}

fn record_activation(vault: &mut Vault, account_id: &str, activated_at: u64) {
    if vault
        .activations
        .last()
        .is_some_and(|activation| activation.account_id == account_id)
    {
        return;
    }
    vault.activations.push(ActivationRecord {
        account_id: account_id.to_string(),
        activated_at,
    });
    if vault.activations.len() > MAX_ACTIVATION_RECORDS {
        let overflow = vault.activations.len() - MAX_ACTIVATION_RECORDS;
        vault.activations.drain(..overflow);
    }
}

fn validate_chatgpt_auth(auth: &Value) -> Result<AuthIdentity, ManagerError> {
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

async fn query_account_quota(
    auth: &Value,
    account_id: &str,
) -> Result<(Option<UsageWindow>, Option<UsageWindow>), QuotaQueryError> {
    let access_token = auth
        .pointer("/tokens/access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| QuotaQueryError::Message("账号缺少可用的访问凭据".to_string()))?;
    let client = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(USAGE_QUERY_TIMEOUT_SECS))
        .build()
        .map_err(|_| QuotaQueryError::Message("无法初始化额度查询".to_string()))?;
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
    let Some(rate_limit) = body.rate_limit else {
        return Ok((None, None));
    };
    Ok((
        rate_limit.primary_window.and_then(to_usage_window),
        rate_limit.secondary_window.and_then(to_usage_window),
    ))
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
            "刷新订阅凭据失败（HTTP {}），请重新登录",
            response.status()
        )));
    }
    let refreshed: OAuthTokenResponse = response
        .json()
        .await
        .map_err(|_| ManagerError::TokenExchange("登录服务返回了无法识别的刷新响应".to_string()))?;
    if refreshed.access_token.trim().is_empty() {
        return Err(ManagerError::TokenExchange(
            "刷新响应缺少 access_token，请重新登录".to_string(),
        ));
    }

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

fn oauth_client() -> Client {
    Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .unwrap_or_else(|_| Client::new())
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
    fn records_only_real_account_switches() {
        let mut vault = Vault::default();
        record_activation(&mut vault, "account-a", 10);
        record_activation(&mut vault, "account-a", 20);
        record_activation(&mut vault, "account-b", 30);

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
            }
        }))
        .unwrap();
        let rate_limit = response.rate_limit.unwrap();
        let primary = to_usage_window(rate_limit.primary_window.unwrap()).unwrap();

        assert_eq!(primary.used_percent, 37.5);
        assert_eq!(primary.window_minutes, Some(300));
        assert_eq!(primary.resets_at, Some(1787533200));
        assert!(rate_limit.secondary_window.is_none());
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
}
