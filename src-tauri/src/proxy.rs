// 本机网络代理设置。
//
// 三种模式：off（无代理）、system（跟随系统/环境）、manual（手动配置代理）。
// 设置持久化到应用数据目录下的 JSON 文件，应用自身的 reqwest 客户端与
// codex app-server 子进程都会按当前模式生效。默认跟随系统，以保持与
// 进程环境（尤其 codex 子进程）一致的网络行为。
//
// 模式是用户主动选择项，这里只持久化地址等配置，不做任何上报或日志输出。
use reqwest::{Client, ClientBuilder, Proxy};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{OnceLock, RwLock},
    time::Duration,
};

const PROXY_FILE_NAME: &str = "network-proxy.json";

// 跟随系统模式会让 codex 子进程保留进程原本的代理环境变量，因此无需改动。
// 手动模式下需要显式注入；无代理模式则要移除可能继承到的代理变量。
const PROXY_ENV_VARS: &[&str] = &[
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProxyMode {
    /// 无代理：即使进程环境或系统里有代理也直连。
    Off,
    /// 跟随系统：使用操作系统与 HTTP(S)_PROXY 环境变量。
    System,
    /// 手动配置：使用下方填写的代理地址。
    Manual,
}

impl Default for ProxyMode {
    fn default() -> Self {
        Self::System
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySettings {
    #[serde(default)]
    pub mode: ProxyMode,
    /// 手动模式下的代理地址，例如 http://127.0.0.1:7890。
    #[serde(default)]
    pub proxy_url: String,
    /// 手动模式下不经过代理的主机列表（逗号分隔），可留空。
    #[serde(default)]
    pub no_proxy: String,
}

impl Default for ProxySettings {
    fn default() -> Self {
        Self {
            mode: ProxyMode::System,
            proxy_url: String::new(),
            no_proxy: String::new(),
        }
    }
}

static SETTINGS: OnceLock<RwLock<Option<ProxySettings>>> = OnceLock::new();
static FILE_PATH: OnceLock<PathBuf> = OnceLock::new();

fn settings_runtime() -> &'static RwLock<Option<ProxySettings>> {
    SETTINGS.get_or_init(|| RwLock::new(None))
}

/// 初始化代理运行时：从应用数据目录读取（或创建默认）配置。
pub fn init(app_data_dir: PathBuf) {
    let path = app_data_dir.join(PROXY_FILE_NAME);
    let loaded = fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ProxySettings>(&bytes).ok())
        .unwrap_or_default();
    if FILE_PATH.set(path).is_ok() {
        let mut guard = match settings_runtime().write() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        *guard = Some(loaded);
    }
}

pub fn get() -> ProxySettings {
    settings_runtime()
        .read()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_default()
}

/// 保存配置并即时生效；写入失败会保留内存中的旧值。
pub fn set(next: ProxySettings) -> Result<ProxySettings, String> {
    let path = FILE_PATH
        .get()
        .ok_or_else(|| "代理设置尚未初始化".to_string())?;
    let bytes = serde_json::to_vec_pretty(&next)
        .map_err(|error| format!("序列化代理设置失败: {error}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| "代理设置路径无效".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建数据目录失败: {error}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &bytes).map_err(|error| format!("写入代理设置失败: {error}"))?;
    fs::rename(&tmp, path).map_err(|error| format!("保存代理设置失败: {error}"))?;
    {
        let mut guard = settings_runtime()
            .write()
            .map_err(|_| "代理设置保存失败".to_string())?;
        *guard = Some(next.clone());
    }
    Ok(next)
}

/// 应用到由调用方配置了超时/user_agent 的 reqwest builder 上。
pub fn apply_to_builder(builder: ClientBuilder) -> Result<ClientBuilder, String> {
    let settings = get();
    match settings.mode {
        ProxyMode::Off => Ok(builder.no_proxy()),
        ProxyMode::System => match Proxy::system() {
            Ok(proxy) => Ok(builder.proxy(proxy)),
            Err(_) => Ok(builder.no_proxy()),
        },
        ProxyMode::Manual => {
            let url = settings.proxy_url.trim();
            if url.is_empty() {
                return Ok(builder.no_proxy());
            }
            match Proxy::all(url) {
                Ok(proxy) => Ok(builder.proxy(proxy)),
                Err(error) => Err(format!("代理地址无效: {error}")),
            }
        }
    }
}

/// 构建一个携带当前代理设置的 reqwest 客户端。
pub fn build_client(
    user_agent: &str,
    timeout: Duration,
    build_error: impl FnOnce() -> String,
) -> Result<Client, String> {
    let builder = Client::builder()
        .user_agent(user_agent)
        .timeout(timeout);
    apply_to_builder(builder)?.build().map_err(|_| build_error())
}

/// 返回当前模式对 codex 子进程应注入/移除的环境变量动作。
pub enum ChildProxyEnv {
    /// 保留进程原本的代理环境（跟随系统）。
    Inherit,
    /// 显式移除代理变量（无代理）。
    Remove,
    /// 注入手动代理与 no_proxy。
    Inject { http_proxy: String, no_proxy: String },
}

pub fn child_proxy_env() -> ChildProxyEnv {
    let settings = get();
    match settings.mode {
        ProxyMode::Off => ChildProxyEnv::Remove,
        ProxyMode::System => ChildProxyEnv::Inherit,
        ProxyMode::Manual => {
            let url = settings.proxy_url.trim();
            if url.is_empty() {
                ChildProxyEnv::Remove
            } else {
                ChildProxyEnv::Inject {
                    http_proxy: url.to_string(),
                    no_proxy: settings.no_proxy.trim().to_string(),
                }
            }
        }
    }
}

pub const PROXY_VARS_FOR_REMOVE: &[&str] = PROXY_ENV_VARS;

// 缓存 key 使用 (设置, 超时秒数)：手动代理切换后会重建客户端，
// 同一次登录轮询期间复用连接池。reqwest 的 Client 是廉价 Arc 克隆。
type ClientCache = HashMap<(ProxySettings, u64), Client>;
static CLIENT_CACHE: OnceLock<RwLock<ClientCache>> = OnceLock::new();

pub fn cached_client(
    user_agent: &str,
    timeout: Duration,
    build_error: impl FnOnce() -> String,
) -> Result<Client, String> {
    let settings = get();
    let key = (settings.clone(), timeout.as_secs());
    let cache = CLIENT_CACHE.get_or_init(|| RwLock::new(HashMap::new()));
    if let Ok(guard) = cache.read() {
        if let Some(client) = guard.get(&key) {
            return Ok(client.clone());
        }
    }
    let client = build_client(user_agent, timeout, build_error)?;
    if let Ok(mut guard) = cache.write() {
        guard.entry(key).or_insert_with(|| client.clone());
    }
    Ok(client)
}
