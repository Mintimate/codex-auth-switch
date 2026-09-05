// 本机网络代理设置。
//
// 三种模式：off（无代理）、system（跟随系统/环境）、manual（手动配置代理）。
// 设置持久化到应用数据目录下的 JSON 文件，应用自身的 reqwest 客户端与
// codex app-server 子进程都会按当前模式生效。默认跟随系统，以保持与
// 进程环境（尤其 codex 子进程）一致的网络行为。
//
// 模式是用户主动选择项，这里只持久化地址等配置，不做任何上报或日志输出。
use reqwest::{Client, ClientBuilder, NoProxy, Proxy};
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
    let mut bytes =
        serde_json::to_vec_pretty(&next).map_err(|error| format!("序列化代理设置失败: {error}"))?;
    bytes.push(b'\n');
    // 复用 manager::atomic_write：tempfile::persist 在 Windows 上也能替换已存在目标，
    // 避免 std::fs::rename 在 Windows 首次保存后稳定失败的问题。
    crate::manager::atomic_write(path, &bytes).map_err(|error| error.to_string())?;
    {
        let mut guard = settings_runtime()
            .write()
            .map_err(|_| "代理设置保存失败".to_string())?;
        *guard = Some(next.clone());
    }
    Ok(next)
}

/// 把一份设置快照应用到由调用方配置了超时/user_agent 的 reqwest builder 上。
/// 始终使用调用方传入的快照，避免构建期间全局设置变化导致行为不一致。
fn apply_to_builder(
    builder: ClientBuilder,
    settings: &ProxySettings,
) -> Result<ClientBuilder, String> {
    match settings.mode {
        ProxyMode::Off => Ok(builder.no_proxy()),
        // reqwest 开启 system-proxy 特性后，默认 builder 会自动附加系统代理
        // （含 HTTP(S)_PROXY 环境变量与系统代理设置），保持默认行为即可。
        ProxyMode::System => Ok(builder),
        ProxyMode::Manual => {
            let url = settings.proxy_url.trim();
            if url.is_empty() {
                return Ok(builder.no_proxy());
            }
            let proxy = Proxy::all(url).map_err(|error| format!("代理地址无效: {error}"))?;
            // 空列表会被解析为“无绕过主机”，因此这里可以无条件绑定。
            let proxy = proxy.no_proxy(NoProxy::from_string(settings.no_proxy.trim()));
            Ok(builder.proxy(proxy))
        }
    }
}

/// 按给定设置快照构建 reqwest 客户端。
fn build_client(
    settings: &ProxySettings,
    user_agent: &str,
    timeout: Duration,
    build_error: impl FnOnce() -> String,
) -> Result<Client, String> {
    let builder = Client::builder().user_agent(user_agent).timeout(timeout);
    apply_to_builder(builder, settings)?
        .build()
        .map_err(|_| build_error())
}

/// 返回当前模式对 codex 子进程应注入/移除的环境变量动作。
pub enum ChildProxyEnv {
    /// 保留进程原本的代理环境（跟随系统）。
    Inherit,
    /// 显式移除代理变量（无代理）。
    Remove,
    /// 注入手动代理与 no_proxy。
    Inject {
        http_proxy: String,
        no_proxy: String,
    },
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
    let client = build_client(&settings, user_agent, timeout, build_error)?;
    if let Ok(mut guard) = cache.write() {
        guard.entry(key).or_insert_with(|| client.clone());
    }
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn saving_twice_replaces_existing_file() {
        let dir = TempDir::new().unwrap();
        init(dir.path().to_path_buf());
        let first = ProxySettings {
            mode: ProxyMode::Manual,
            proxy_url: "http://127.0.0.1:7890".to_string(),
            no_proxy: String::new(),
        };
        set(first).unwrap();
        let second = ProxySettings {
            mode: ProxyMode::Manual,
            proxy_url: "http://127.0.0.1:1080".to_string(),
            no_proxy: "localhost".to_string(),
        };
        set(second.clone()).unwrap();
        assert_eq!(get(), second);
        let bytes = fs::read(dir.path().join(PROXY_FILE_NAME)).unwrap();
        let restored: ProxySettings = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(restored, second);
    }
}
