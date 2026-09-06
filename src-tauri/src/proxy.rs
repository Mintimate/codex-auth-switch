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
    path::{Path, PathBuf},
    sync::{OnceLock, RwLock},
    time::Duration,
};

const PROXY_FILE_NAME: &str = "network-proxy.json";

// 跟随系统模式保留代理环境变量，并由调用方启用 Codex 系统代理策略。
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

static SETTINGS: OnceLock<RwLock<Result<ProxySettings, String>>> = OnceLock::new();
static FILE_PATH: OnceLock<PathBuf> = OnceLock::new();

fn settings_runtime() -> &'static RwLock<Result<ProxySettings, String>> {
    SETTINGS.get_or_init(|| RwLock::new(Err("代理设置尚未初始化".to_string())))
}

/// 保留读取错误，允许界面启动；网络调用必须先取得有效配置。
pub fn init(app_data_dir: PathBuf) {
    let path = app_data_dir.join(PROXY_FILE_NAME);
    if FILE_PATH.set(path.clone()).is_ok() {
        if let Ok(mut guard) = settings_runtime().write() {
            *guard = read_settings(&path);
        }
    }
}

fn read_settings(path: &Path) -> Result<ProxySettings, String> {
    let loaded = match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<ProxySettings>(&bytes)
            .map_err(|_| "代理配置文件格式错误，请检查 network-proxy.json".to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ProxySettings::default(),
        Err(_) => {
            return Err("无法读取代理配置文件，请检查 network-proxy.json 的访问权限".to_string())
        }
    };
    validate(&loaded)?;
    Ok(loaded)
}

fn validate(settings: &ProxySettings) -> Result<(), String> {
    if settings.mode == ProxyMode::Manual {
        let url = reqwest::Url::parse(settings.proxy_url.trim())
            .map_err(|_| "请输入有效的 HTTP(S) 代理地址".to_string())?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err("请输入有效的 HTTP(S) 代理地址".to_string());
        }
        Proxy::all(url).map_err(|_| "请输入有效的 HTTP(S) 代理地址".to_string())?;
    }
    Ok(())
}

pub fn get() -> Result<ProxySettings, String> {
    let mut guard = settings_runtime()
        .write()
        .map_err(|_| "无法读取代理设置".to_string())?;
    // 用户修复文件后可重新打开设置页恢复，无需重启或覆盖坏文件。
    if guard.is_err() {
        if let Some(path) = FILE_PATH.get() {
            *guard = read_settings(path);
        }
    }
    guard.clone()
}

/// 保存配置并即时生效；写入失败会保留内存中的旧值。
pub fn set(next: ProxySettings) -> Result<ProxySettings, String> {
    validate(&next)?;
    let path = FILE_PATH
        .get()
        .ok_or_else(|| "代理设置尚未初始化".to_string())?;
    let mut bytes =
        serde_json::to_vec_pretty(&next).map_err(|error| format!("序列化代理设置失败: {error}"))?;
    bytes.push(b'\n');
    // 与客户端构建使用同一把缓存锁，避免清空后又写回旧设置的客户端。
    let mut cache = client_cache()
        .write()
        .map_err(|_| "代理设置保存失败".to_string())?;
    let mut guard = settings_runtime()
        .write()
        .map_err(|_| "代理设置保存失败".to_string())?;
    // 复用 manager::atomic_write：tempfile::persist 在 Windows 上也能替换已存在目标,
    // 避免 std::fs::rename 在 Windows 首次保存后稳定失败的问题。
    crate::manager::atomic_write(path, &bytes).map_err(|error| error.to_string())?;
    *guard = Ok(next.clone());
    cache.clear();
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
            let proxy = Proxy::all(url).map_err(|_| "请输入有效的 HTTP(S) 代理地址".to_string())?;
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

pub fn child_proxy_env(settings: &ProxySettings) -> ChildProxyEnv {
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

// 仅保留当前设置的各超时客户端；保存配置后清空，以重新读取系统代理。
// 同一次登录轮询期间复用连接池。reqwest 的 Client 是廉价 Arc 克隆。
type ClientCache = HashMap<(ProxySettings, u64), Client>;
static CLIENT_CACHE: OnceLock<RwLock<ClientCache>> = OnceLock::new();

fn client_cache() -> &'static RwLock<ClientCache> {
    CLIENT_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

pub fn cached_client(
    user_agent: &str,
    timeout: Duration,
    build_error: impl FnOnce() -> String,
) -> Result<Client, String> {
    // 锁顺序与 set 一致：先缓存再设置；构建完成前不允许切换配置。
    let mut cache = client_cache()
        .write()
        .map_err(|_| "无法读取代理设置".to_string())?;
    let settings = get()?;
    let key = (settings.clone(), timeout.as_secs());
    if let Some(client) = cache.get(&key) {
        return Ok(client.clone());
    }
    let client = build_client(&settings, user_agent, timeout, build_error)?;
    cache.insert(key, client.clone());
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn http_stub(body: &'static str) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(stream.read_u8().await.unwrap());
                }
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
        });
        (address, task)
    }

    #[test]
    fn requests_follow_off_manual_and_bypass_rules() {
        tauri::async_runtime::block_on(async {
            let (origin, origin_task) = http_stub("origin").await;
            let (proxy, proxy_task) = http_stub("proxy").await;
            for (mode, no_proxy, expected) in [
                (ProxyMode::Off, "", "origin"),
                (ProxyMode::Manual, "", "proxy"),
                (ProxyMode::Manual, "127.0.0.1", "origin"),
            ] {
                let settings = ProxySettings {
                    mode,
                    proxy_url: format!("http://{proxy}"),
                    no_proxy: no_proxy.into(),
                };
                let mut builder = Client::builder().timeout(Duration::from_secs(3));
                if mode == ProxyMode::Off {
                    // 即使 builder 已有代理，off 也必须清除它；不修改测试进程的环境。
                    builder = builder.proxy(Proxy::all(&settings.proxy_url).unwrap());
                }
                let client = apply_to_builder(builder, &settings)
                    .unwrap()
                    .build()
                    .unwrap();
                let response = client
                    .get(format!("http://{origin}/route"))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(response.text().await.unwrap(), expected);
            }
            origin_task.abort();
            proxy_task.abort();
        });
    }

    #[test]
    fn unreadable_or_corrupt_settings_are_not_defaults() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(PROXY_FILE_NAME);
        fs::write(&path, b"invalid json").unwrap();
        assert!(read_settings(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"invalid json");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(read_settings(&path).is_err());
    }

    #[test]
    fn settings_recovery_saves_and_cache_invalidation() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(PROXY_FILE_NAME);
        fs::write(&path, b"invalid json").unwrap();
        init(dir.path().to_path_buf());
        assert!(get().is_err());
        assert!(cached_client("test", Duration::from_secs(1), || "build failed".into()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"invalid json");
        fs::write(&path, b"{}").unwrap();
        assert_eq!(get().unwrap(), ProxySettings::default());
        for timeout in [1, 2, 1] {
            cached_client("test", Duration::from_secs(timeout), || {
                "build failed".into()
            })
            .unwrap();
        }
        assert_eq!(client_cache().read().unwrap().len(), 2);
        let first = ProxySettings {
            mode: ProxyMode::Manual,
            proxy_url: "http://127.0.0.1:7890".to_string(),
            no_proxy: String::new(),
        };
        set(first).unwrap();
        assert!(client_cache().read().unwrap().is_empty());
        set(ProxySettings::default()).unwrap();
        assert!(client_cache().read().unwrap().is_empty());
        cached_client("test", Duration::from_secs(1), || "build failed".into()).unwrap();
        assert_eq!(client_cache().read().unwrap().len(), 1);
        let second = ProxySettings {
            mode: ProxyMode::Manual,
            proxy_url: "http://127.0.0.1:1080".to_string(),
            no_proxy: "localhost".to_string(),
        };
        set(second.clone()).unwrap();
        assert!(client_cache().read().unwrap().is_empty());
        cached_client("test", Duration::from_secs(1), || "build failed".into()).unwrap();
        assert_eq!(get().unwrap(), second);
        let bytes = fs::read(dir.path().join(PROXY_FILE_NAME)).unwrap();
        let restored: ProxySettings = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(restored, second);
        for url in ["", "http://[invalid", "socks5://127.0.0.1:1080"] {
            let invalid = ProxySettings {
                proxy_url: url.to_string(),
                ..second.clone()
            };
            assert!(set(invalid).is_err());
            assert_eq!(client_cache().read().unwrap().len(), 1);
            assert_eq!(get().unwrap(), second);
            assert_eq!(fs::read(dir.path().join(PROXY_FILE_NAME)).unwrap(), bytes);
        }
        // 即使保存相同的 system 值，也应刷新系统代理快照。
        set(ProxySettings::default()).unwrap();
        cached_client("test", Duration::from_secs(1), || "build failed".into()).unwrap();
        set(ProxySettings::default()).unwrap();
        assert!(client_cache().read().unwrap().is_empty());
    }
}
