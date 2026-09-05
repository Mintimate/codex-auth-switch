use chrono::{DateTime, Days, Local, NaiveDate};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

const HISTORY_DAYS: u64 = 30;
const TREND_DAYS: u64 = 14;
const FILE_SCAN_GRACE_DAYS: u64 = 35;

pub(crate) const OPENAI_MODEL_PROVIDER: &str = "openai";
const UNATTRIBUTED_PROVIDER_ID: &str = "unattributed";

// model_provider 只能说明请求使用的模型提供方，不能证明认证或最终计费方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelProviderKind {
    Openai,
    ThirdParty,
    Unattributed,
}

impl ModelProviderKind {
    pub(crate) fn provider_id(self) -> &'static str {
        match self {
            Self::Openai => OPENAI_MODEL_PROVIDER,
            Self::ThirdParty => "third-party",
            Self::Unattributed => UNATTRIBUTED_PROVIDER_ID,
        }
    }
}

// config.toml 的 [model_providers.<id>] 提供显示名，否则界面上只能看到
// 诸如 custom 这类没有信息量的内部 id。
#[derive(Debug, Clone, Default)]
pub(crate) struct ProviderCatalog {
    providers: Vec<ProviderMeta>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderMeta {
    pub id: String,
    pub name: Option<String>,
    pub base_url: Option<String>,
}

impl ProviderCatalog {
    pub(crate) fn from_config(config: &toml::Table) -> Self {
        let mut providers = Vec::new();
        let Some(table) = config
            .get("model_providers")
            .and_then(toml::Value::as_table)
        else {
            return Self { providers };
        };
        for (id, value) in table {
            let Some(entry) = value.as_table() else {
                continue;
            };
            providers.push(ProviderMeta {
                id: id.clone(),
                name: entry
                    .get("name")
                    .and_then(toml::Value::as_str)
                    .map(|name| name.trim().to_string())
                    .filter(|name| !name.is_empty()),
                // base_url 只取主机部分用于分组标签，不回传完整地址。
                base_url: entry
                    .get("base_url")
                    .and_then(toml::Value::as_str)
                    .map(|url| url.trim().to_string())
                    .filter(|url| !url.is_empty()),
            });
        }
        Self { providers }
    }

    fn meta(&self, provider_id: &str) -> Option<&ProviderMeta> {
        self.providers
            .iter()
            .find(|provider| provider.id == provider_id)
    }

    // 第三方提供方按 provider id 分桶，避免多个接入被合并。
    pub(crate) fn usage_id(&self, provider_id: &str) -> String {
        if provider_id == OPENAI_MODEL_PROVIDER {
            return OPENAI_MODEL_PROVIDER.to_string();
        }
        format!("provider:{provider_id}")
    }

    pub(crate) fn label(&self, provider_id: &str) -> String {
        if provider_id == OPENAI_MODEL_PROVIDER {
            return provider_label(ModelProviderKind::Openai).to_string();
        }
        self.meta(provider_id)
            .and_then(|provider| provider.name.clone())
            .unwrap_or_else(|| provider_id.to_string())
    }

    pub(crate) fn host(&self, provider_id: &str) -> Option<String> {
        self.meta(provider_id)
            .and_then(|provider| provider.base_url.as_deref())
            .and_then(host_of)
    }

    // OpenAI 默认 provider 不在此列，由调用方单独加入。
    pub(crate) fn known_providers(&self) -> Vec<(String, String)> {
        let mut known = self
            .providers
            .iter()
            .filter(|provider| provider.id != OPENAI_MODEL_PROVIDER)
            .map(|provider| (provider.id.clone(), self.label(&provider.id)))
            .collect::<Vec<_>>();
        known.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));
        known
    }
}

// 取 URL 的 authority（含端口）：本地代理常用不同端口区分服务，
// 丢掉端口会让同一主机上的不同本地代理看起来一样。
// 同时剥掉路径与查询串，不把服务细节送进前端。
fn host_of(base_url: &str) -> Option<String> {
    let rest = base_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(base_url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let authority = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    let authority = authority.trim();
    (!authority.is_empty()).then(|| authority.to_string())
}

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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
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
    #[serde(default)]
    pub by_provider: Vec<DailyProviderUsage>,
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
pub struct ModelProviderUsage {
    pub id: String,
    pub label: String,
    pub kind: ModelProviderKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    pub tokens: TokenBreakdown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyProviderUsage {
    pub id: String,
    pub total_tokens: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProviderOption {
    pub id: String,
    pub label: String,
    pub kind: ModelProviderKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProviderState {
    // 当前 config.toml 里生效的 provider，用于提示「现在跑在哪条路上」。
    pub active_provider: Option<String>,
    pub active_id: String,
    pub providers: Vec<ModelProviderOption>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUsageStats {
    pub today: TokenBreakdown,
    pub seven_days: TokenBreakdown,
    pub thirty_days: TokenBreakdown,
    pub daily: Vec<DailyUsage>,
    #[serde(default)]
    pub by_provider: Vec<ModelProviderUsage>,
    pub by_account: Vec<AccountTokenUsage>,
    pub unassigned: TokenBreakdown,
    pub files_scanned: u32,
    pub events_count: u32,
    pub generated_at: u64,
}

#[derive(Deserialize)]
struct SessionEvent {
    timestamp: Option<String>,
    #[serde(flatten)]
    kind: SessionEventKind,
}

#[derive(Deserialize)]
#[serde(tag = "type", content = "payload")]
enum SessionEventKind {
    #[serde(rename = "session_meta")]
    SessionMeta(SessionMetaPayload),
    #[serde(rename = "event_msg")]
    EventMessage(EventMessagePayload),
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct SessionMetaPayload {
    model_provider: Option<String>,
}

#[derive(Deserialize)]
struct EventMessagePayload {
    #[serde(rename = "type")]
    kind: String,
    info: Option<Value>,
}

const USAGE_CACHE_VERSION: u32 = 2;
pub(crate) const USAGE_CACHE_FILE: &str = "usage-cache.v2.json.gz";
const MAX_CACHE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CACHE_DECODED_BYTES: u64 = 64 * 1024 * 1024;
const CACHE_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const CHECKPOINT_BYTES: u64 = 4096;
static USAGE_CACHE_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Default, Serialize, Deserialize)]
struct UsageCache {
    version: u32,
    codex_home: PathBuf,
    files: HashMap<PathBuf, CachedSession>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl FileStamp {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            created: metadata.created().ok(),
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        }
    }
    fn same_file(&self, other: &Self) -> bool {
        #[cfg(unix)]
        if self.device != other.device || self.inode != other.inode {
            return false;
        }
        self.created == other.created
    }
}

// 缓存不保留 JSONL 原文、提示词、回复或认证数据。
#[derive(Serialize, Deserialize)]
struct CachedSession {
    stamp: FileStamp,
    offset: u64,
    prefix_hash: u64,
    boundary_hash: u64,
    previous_total: Option<TokenBreakdown>,
    provider_id: Option<String>,
    events: Vec<CachedUsageEvent>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(from = "(u64, [u64; 6])", into = "(u64, [u64; 6])")]
struct CachedUsageEvent {
    timestamp: u64,
    tokens: TokenBreakdown,
}

impl From<(u64, [u64; 6])> for CachedUsageEvent {
    fn from((timestamp, n): (u64, [u64; 6])) -> Self {
        Self {
            timestamp,
            tokens: TokenBreakdown {
                input_tokens: n[0],
                cached_input_tokens: n[1],
                cache_write_input_tokens: n[2],
                output_tokens: n[3],
                reasoning_output_tokens: n[4],
                total_tokens: n[5],
            },
        }
    }
}
impl From<CachedUsageEvent> for (u64, [u64; 6]) {
    fn from(event: CachedUsageEvent) -> Self {
        let t = event.tokens;
        (
            event.timestamp,
            [
                t.input_tokens,
                t.cached_input_tokens,
                t.cache_write_input_tokens,
                t.output_tokens,
                t.reasoning_output_tokens,
                t.total_tokens,
            ],
        )
    }
}

#[derive(Debug, PartialEq, Eq)]
enum CacheRead {
    Reused,
    Appended,
    Rescanned,
}

fn checkpoint(file: &mut File, start: u64, length: u64) -> std::io::Result<u64> {
    use std::hash::{Hash, Hasher};
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = vec![0; length as usize];
    file.read_exact(&mut bytes)?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    Ok(hasher.finish())
}

impl UsageCache {
    fn update_file(&mut self, path: &Path) -> std::io::Result<CacheRead> {
        let mut file = File::open(path)?;
        let stamp = FileStamp::from_metadata(&file.metadata()?);
        let old = self.files.remove(path);
        if old
            .as_ref()
            .is_some_and(|old| old.stamp == stamp && old.offset <= stamp.len)
        {
            self.files.insert(path.to_path_buf(), old.unwrap());
            return Ok(CacheRead::Reused);
        }
        let can_append = if let Some(old) = old.as_ref() {
            old.stamp.same_file(&stamp)
                && stamp.len > old.stamp.len
                && old.offset <= old.stamp.len
                && checkpoint(&mut file, 0, old.offset.min(CHECKPOINT_BYTES))? == old.prefix_hash
                && checkpoint(
                    &mut file,
                    old.offset.saturating_sub(CHECKPOINT_BYTES),
                    old.offset.min(CHECKPOINT_BYTES),
                )? == old.boundary_hash
        } else {
            false
        };
        let mode = if can_append {
            CacheRead::Appended
        } else {
            CacheRead::Rescanned
        };
        let mut cached = if can_append {
            old.unwrap()
        } else {
            CachedSession {
                stamp: stamp.clone(),
                offset: 0,
                prefix_hash: 0,
                boundary_hash: 0,
                previous_total: None,
                provider_id: None,
                events: Vec::new(),
            }
        };
        file.seek(SeekFrom::Start(cached.offset))?;
        // 只读取本次快照长度；写到一半的尾行留到下次读取，避免重计或漏计。
        let mut reader = BufReader::new((&mut file).take(stamp.len - cached.offset));
        let mut line = Vec::new();
        loop {
            line.clear();
            let read = reader.read_until(b'\n', &mut line)?;
            if read == 0 || line.last() != Some(&b'\n') {
                break;
            }
            cached.offset += read as u64;
            let Ok(line) = std::str::from_utf8(&line) else {
                continue;
            };
            if !line.contains("\"session_meta\"") && !line.contains("\"token_count\"") {
                continue;
            }
            let Ok(event) = serde_json::from_str::<SessionEvent>(line) else {
                continue;
            };
            let payload = match event.kind {
                SessionEventKind::SessionMeta(payload) => {
                    if cached.provider_id.is_none() {
                        cached.provider_id = payload
                            .model_provider
                            .map(|id| id.trim().to_string())
                            .filter(|id| !id.is_empty());
                    }
                    continue;
                }
                SessionEventKind::EventMessage(payload) if payload.kind == "token_count" => payload,
                _ => continue,
            };
            let Some(info) = payload.info.as_ref().filter(|info| info.is_object()) else {
                continue;
            };
            let current_total = info
                .get("total_token_usage")
                .and_then(parse_token_breakdown);
            let delta = info
                .get("last_token_usage")
                .and_then(parse_token_breakdown)
                .or_else(|| {
                    current_total.map(|current| {
                        cached
                            .previous_total
                            .map_or(current, |previous| current.saturating_sub(previous))
                    })
                });
            if let Some(total) = current_total {
                cached.previous_total = Some(total);
            }
            if let (Some(tokens), Some((_, timestamp))) =
                (delta, event.timestamp.as_deref().and_then(parse_event_time))
            {
                cached.events.push(CachedUsageEvent { timestamp, tokens });
            }
        }
        drop(reader);
        cached.prefix_hash = checkpoint(&mut file, 0, cached.offset.min(CHECKPOINT_BYTES))?;
        cached.boundary_hash = checkpoint(
            &mut file,
            cached.offset.saturating_sub(CHECKPOINT_BYTES),
            cached.offset.min(CHECKPOINT_BYTES),
        )?;
        cached.stamp = stamp;
        self.files.insert(path.to_path_buf(), cached);
        Ok(mode)
    }

    fn refresh(&mut self, codex_home: &Path, today: NaiveDate) -> bool {
        let previous_count = self.files.len();
        let paths = collect_recent_session_files(codex_home);
        self.files
            .retain(|path, _| paths.binary_search(path).is_ok());
        let mut changed = self.files.len() != previous_count;
        for path in paths {
            match self.update_file(&path) {
                Ok(CacheRead::Reused) => {}
                Ok(_) => changed = true,
                Err(_) => {
                    self.files.remove(&path);
                    changed = true;
                }
            }
        }
        let cutoff = today
            .checked_sub_days(Days::new(FILE_SCAN_GRACE_DAYS))
            .unwrap_or(today);
        for file in self.files.values_mut() {
            let count = file.events.len();
            file.events
                .retain(|event| event_date(event.timestamp).is_some_and(|date| date >= cutoff));
            changed |= count != file.events.len();
        }
        changed
    }
}

fn event_date(timestamp: u64) -> Option<NaiveDate> {
    DateTime::from_timestamp(i64::try_from(timestamp).ok()?, 0)
        .map(|date| date.with_timezone(&Local).date_naive())
}

pub(crate) fn scan_local_usage_cached(
    codex_home: &Path,
    cache_path: &Path,
    activations: &[ActivationRecord],
    accounts: &[AccountLabel],
    catalog: &ProviderCatalog,
) -> LocalUsageStats {
    let _guard = USAGE_CACHE_GATE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let today = Local::now().date_naive();
    let _ = maintain_usage_cache(cache_path);
    let loaded = File::open(cache_path)
        .ok()
        .and_then(|file| {
            let decoder = GzDecoder::new(file.take(MAX_CACHE_BYTES + 1));
            let mut json = serde_json::Deserializer::from_reader(BufReader::new(
                decoder.take(MAX_CACHE_DECODED_BYTES + 1),
            ));
            let cache = UsageCache::deserialize(&mut json).ok()?;
            json.end().ok()?;
            Some(cache)
        })
        .filter(|cache| cache.version == USAGE_CACHE_VERSION && cache.codex_home == codex_home);
    let needs_save = loaded.is_none();
    let mut cache = loaded.unwrap_or_else(|| UsageCache {
        version: USAGE_CACHE_VERSION,
        codex_home: codex_home.to_path_buf(),
        files: HashMap::new(),
    });
    let changed = cache.refresh(codex_home, today);
    let stats = aggregate_local_usage(&cache, activations, accounts, catalog, today);
    if changed || needs_save {
        if let Some(bytes) =
            bounded_cache_bytes(&mut cache, MAX_CACHE_BYTES, MAX_CACHE_DECODED_BYTES)
        {
            // 容量淘汰只影响下次读取速度，当前返回值始终使用完整统计。
            let _ = crate::manager::atomic_write(cache_path, &bytes);
        }
    }
    stats
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageCacheInfo {
    pub bytes: u64,
    pub max_bytes: u64,
}

// 只处理应用自己创建的两个固定文件，不遍历或删除 Codex 会话与账号库。
fn remove_cache_file(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

fn maintain_usage_cache(path: &Path) -> std::io::Result<()> {
    remove_cache_file(&path.with_file_name("usage-cache.v1.json"))?;
    if let Ok(meta) = fs::metadata(path) {
        let expired = meta
            .modified()
            .ok()
            .and_then(|time| SystemTime::now().duration_since(time).ok())
            .is_some_and(|age| age >= CACHE_MAX_AGE);
        if meta.len() > MAX_CACHE_BYTES || expired {
            remove_cache_file(path)?;
        }
    }
    Ok(())
}

pub(crate) fn usage_cache_info(path: &Path, clear: bool) -> std::io::Result<UsageCacheInfo> {
    let _guard = USAGE_CACHE_GATE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    maintain_usage_cache(path)?;
    if clear {
        remove_cache_file(path)?;
    }
    let bytes = match fs::metadata(path) {
        Ok(meta) => meta.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error),
    };
    Ok(UsageCacheInfo {
        bytes,
        max_bytes: MAX_CACHE_BYTES,
    })
}

struct LimitedWriter<W> {
    inner: W,
    remaining: u64,
}
impl<W: Write> Write for LimitedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() as u64 > self.remaining {
            return Err(std::io::Error::other("usage cache capacity exceeded"));
        }
        let count = self.inner.write(bytes)?;
        self.remaining -= count as u64;
        Ok(count)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

fn encode_cache(cache: &UsageCache, max_disk: u64, max_decoded: u64) -> Option<Vec<u8>> {
    let compressed = LimitedWriter {
        inner: Vec::new(),
        remaining: max_disk,
    };
    let encoder = GzEncoder::new(compressed, Compression::fast());
    let mut writer = LimitedWriter {
        inner: encoder,
        remaining: max_decoded,
    };
    serde_json::to_writer(&mut writer, cache).ok()?;
    Some(writer.inner.finish().ok()?.inner)
}

fn bounded_cache_bytes(cache: &mut UsageCache, max_disk: u64, max_decoded: u64) -> Option<Vec<u8>> {
    loop {
        if let Some(bytes) = encode_cache(cache, max_disk, max_decoded) {
            return Some(bytes);
        }
        if cache.files.is_empty() {
            return None;
        }
        let mut oldest = cache
            .files
            .iter()
            .map(|(path, entry)| (path.clone(), entry.stamp.modified))
            .collect::<Vec<_>>();
        oldest.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
        // 批量淘汰较旧文件，避免每移除一个文件都重新压缩整个缓存。
        for (path, _) in oldest.into_iter().take(cache.files.len().div_ceil(2)) {
            cache.files.remove(&path);
        }
    }
}

#[cfg(test)]
fn scan_local_usage_for_date(
    codex_home: &Path,
    activations: &[ActivationRecord],
    accounts: &[AccountLabel],
    catalog: &ProviderCatalog,
    today: NaiveDate,
) -> LocalUsageStats {
    let mut cache = UsageCache::default();
    cache.refresh(codex_home, today);
    aggregate_local_usage(&cache, activations, accounts, catalog, today)
}

fn aggregate_local_usage(
    cache: &UsageCache,
    activations: &[ActivationRecord],
    accounts: &[AccountLabel],
    catalog: &ProviderCatalog,
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
    let mut by_provider: HashMap<String, TokenBreakdown> = HashMap::new();
    let mut daily_by_provider: BTreeMap<NaiveDate, HashMap<String, u64>> = BTreeMap::new();
    let mut today_tokens = TokenBreakdown::default();
    let mut seven_days = TokenBreakdown::default();
    let mut thirty_days = TokenBreakdown::default();
    let mut unassigned = TokenBreakdown::default();
    let mut files_scanned = 0u32;
    let mut events_count = 0u32;

    for file in cache.files.values() {
        files_scanned = files_scanned.saturating_add(1);
        let mut file_tokens = TokenBreakdown::default();
        let mut file_daily_tokens: BTreeMap<NaiveDate, u64> = BTreeMap::new();
        for event in &file.events {
            let token_delta = event.tokens;
            let event_timestamp = event.timestamp;
            let Some(event_date) = event_date(event_timestamp) else {
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

            file_tokens.add(token_delta);
            if event_date >= trend_start {
                file_daily_tokens
                    .entry(event_date)
                    .and_modify(|total| *total = total.saturating_add(token_delta.total_tokens))
                    .or_insert(token_delta.total_tokens);
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

        let usage_id = match file.provider_id.as_deref() {
            Some(provider) => catalog.usage_id(provider),
            None => UNATTRIBUTED_PROVIDER_ID.to_string(),
        };
        if file_tokens.total_tokens > 0 {
            by_provider
                .entry(usage_id.clone())
                .or_default()
                .add(file_tokens);
        }
        for (date, total_tokens) in file_daily_tokens {
            daily_by_provider
                .entry(date)
                .or_default()
                .entry(usage_id.clone())
                .and_modify(|total| *total = total.saturating_add(total_tokens))
                .or_insert(total_tokens);
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

    let mut provider_usage = by_provider
        .into_iter()
        .map(|(id, tokens)| {
            let (kind, provider_id) = match id.strip_prefix("provider:") {
                Some(provider) => (ModelProviderKind::ThirdParty, Some(provider.to_string())),
                None if id == OPENAI_MODEL_PROVIDER => {
                    (ModelProviderKind::Openai, Some(id.clone()))
                }
                _ => (ModelProviderKind::Unattributed, None),
            };
            let (label, host) = match provider_id.as_deref() {
                Some(provider) => (catalog.label(provider), catalog.host(provider)),
                None => (provider_label(kind).to_string(), None),
            };
            ModelProviderUsage {
                id,
                label,
                kind,
                host,
                tokens,
            }
        })
        .collect::<Vec<_>>();
    // OpenAI 默认提供方排最前，未归因排最后，第三方按用量降序。
    provider_usage.sort_by(|left, right| {
        let rank = |kind: ModelProviderKind| match kind {
            ModelProviderKind::Openai => 0,
            ModelProviderKind::ThirdParty => 1,
            ModelProviderKind::Unattributed => 2,
        };
        rank(left.kind)
            .cmp(&rank(right.kind))
            .then_with(|| right.tokens.total_tokens.cmp(&left.tokens.total_tokens))
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
                by_provider: daily_by_provider
                    .get(&date)
                    .map(|totals| {
                        totals
                            .iter()
                            .map(|(id, total_tokens)| DailyProviderUsage {
                                id: id.clone(),
                                total_tokens: *total_tokens,
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                tokens,
            })
            .collect(),
        by_provider: provider_usage,
        by_account: account_usage,
        unassigned,
        files_scanned,
        events_count,
        generated_at: unix_timestamp(),
    }
}

pub(crate) fn provider_label(kind: ModelProviderKind) -> &'static str {
    match kind {
        ModelProviderKind::Openai => "OpenAI 默认提供方",
        ModelProviderKind::ThirdParty => "第三方模型提供方",
        ModelProviderKind::Unattributed => "未识别提供方",
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

fn parse_event_time(timestamp: &str) -> Option<(NaiveDate, u64)> {
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
    use chrono::{Datelike, Local, TimeZone};
    use serde_json::json;
    use std::io::Write;
    use tempfile::TempDir;

    fn cumulative_line(total: u64) -> String {
        format!(
            "{}\n",
            json!({"timestamp": Local::now().to_rfc3339(), "type":"event_msg", "payload": {
                "type":"token_count", "info":{"total_token_usage":{"total_tokens":total}}
            }})
        )
    }

    fn cached_total(cache: &UsageCache) -> u64 {
        aggregate_local_usage(
            cache,
            &[],
            &[],
            &ProviderCatalog::default(),
            Local::now().date_naive(),
        )
        .today
        .total_tokens
    }

    #[test]
    fn cache_reuses_files_and_counts_only_complete_appended_events() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("session.jsonl");
        fs::write(&path, cumulative_line(100)).unwrap();
        let mut cache = UsageCache::default();
        assert_eq!(cache.update_file(&path).unwrap(), CacheRead::Rescanned);
        assert_eq!(cache.update_file(&path).unwrap(), CacheRead::Reused);
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(cumulative_line(150).as_bytes()).unwrap();
        assert_eq!(cache.update_file(&path).unwrap(), CacheRead::Appended);
        assert_eq!(cached_total(&cache), 150);
        let partial = cumulative_line(200);
        let split = partial.len() / 2;
        file.write_all(&partial.as_bytes()[..split]).unwrap();
        cache.update_file(&path).unwrap();
        assert_eq!(cached_total(&cache), 150);
        file.write_all(&partial.as_bytes()[split..]).unwrap();
        cache.update_file(&path).unwrap();
        assert_eq!(cached_total(&cache), 200);
        assert_eq!(cache.update_file(&path).unwrap(), CacheRead::Reused);
        assert_eq!(cached_total(&cache), 200);
    }

    #[test]
    fn cache_rebuilds_after_truncation_same_size_edit_and_replacement() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("session.jsonl");
        let original = cumulative_line(100);
        fs::write(&path, original.repeat(2)).unwrap();
        let mut cache = UsageCache::default();
        cache.update_file(&path).unwrap();
        fs::write(&path, &original).unwrap();
        assert_eq!(cache.update_file(&path).unwrap(), CacheRead::Rescanned);
        let edited = original.replace(":100", ":200");
        assert_eq!(edited.len(), original.len());
        fs::write(&path, &edited).unwrap();
        File::open(&path)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(SystemTime::now() + Duration::from_secs(2)),
            )
            .unwrap();
        assert_eq!(cache.update_file(&path).unwrap(), CacheRead::Rescanned);
        assert_eq!(cached_total(&cache), 200);
        fs::rename(&path, root.path().join("old.jsonl")).unwrap();
        fs::write(&path, cumulative_line(300)).unwrap();
        assert_eq!(cache.update_file(&path).unwrap(), CacheRead::Rescanned);
        assert_eq!(cached_total(&cache), 300);
    }

    #[test]
    fn cache_survives_restart_excludes_raw_content_and_removes_deleted_files() {
        let root = TempDir::new().unwrap();
        let sessions = root.path().join("sessions");
        fs::create_dir(&sessions).unwrap();
        let path = sessions.join("session.jsonl");
        fs::write(
            &path,
            format!(
                "{}{}{}",
                json!({"type":"response_item","payload":{"text":"PRIVATE_PROMPT_MARKER"}}),
                "\n",
                cumulative_line(100)
            ),
        )
        .unwrap();
        let cache_path = root.path().join("app").join(USAGE_CACHE_FILE);
        let first = scan_local_usage_cached(
            root.path(),
            &cache_path,
            &[],
            &[],
            &ProviderCatalog::default(),
        );
        assert_eq!(first.today.total_tokens, 100);
        let bytes = fs::read(&cache_path).unwrap();
        let mut decoded = String::new();
        GzDecoder::new(bytes.as_slice())
            .read_to_string(&mut decoded)
            .unwrap();
        assert!(!decoded.contains("PRIVATE_PROMPT_MARKER"));
        let mut loaded: UsageCache =
            serde_json::from_reader(GzDecoder::new(bytes.as_slice())).unwrap();
        assert_eq!(loaded.update_file(&path).unwrap(), CacheRead::Reused);
        let modified = fs::metadata(&cache_path).unwrap().modified().unwrap();
        assert_eq!(
            scan_local_usage_cached(
                root.path(),
                &cache_path,
                &[],
                &[],
                &ProviderCatalog::default()
            )
            .today
            .total_tokens,
            100
        );
        assert_eq!(
            fs::metadata(&cache_path).unwrap().modified().unwrap(),
            modified
        );
        fs::remove_file(&path).unwrap();
        assert_eq!(
            scan_local_usage_cached(
                root.path(),
                &cache_path,
                &[],
                &[],
                &ProviderCatalog::default()
            )
            .today
            .total_tokens,
            0
        );
        fs::write(&cache_path, b"corrupted cache").unwrap();
        fs::write(&path, cumulative_line(300)).unwrap();
        assert_eq!(
            scan_local_usage_cached(
                root.path(),
                &cache_path,
                &[],
                &[],
                &ProviderCatalog::default()
            )
            .today
            .total_tokens,
            300
        );
    }

    #[test]
    fn cached_counts_are_reaggregated_for_new_account_history_and_date() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("session.jsonl");
        fs::write(&path, cumulative_line(100)).unwrap();
        let mut cache = UsageCache::default();
        cache.update_file(&path).unwrap();
        let today = Local::now().date_naive();
        let history = [ActivationRecord {
            account_id: "account-a".into(),
            activated_at: 0,
        }];
        let stats =
            aggregate_local_usage(&cache, &history, &[], &ProviderCatalog::default(), today);
        assert_eq!(stats.by_account[0].tokens.total_tokens, 100);
        let tomorrow = today.checked_add_days(Days::new(1)).unwrap();
        let stats = aggregate_local_usage(&cache, &[], &[], &ProviderCatalog::default(), tomorrow);
        assert_eq!(stats.today.total_tokens, 0);
        assert_eq!(stats.seven_days.total_tokens, 100);
        assert_eq!(stats.unassigned.total_tokens, 100);
    }

    #[test]
    fn cache_cleanup_removes_only_owned_cache_files_and_expires_old_data() {
        let root = TempDir::new().unwrap();
        let path = root.path().join(USAGE_CACHE_FILE);
        let legacy = root.path().join("usage-cache.v1.json");
        let credentials = root.path().join("accounts.v1.json");
        let session = root.path().join("session.jsonl");
        fs::write(&credentials, "synthetic-preserve").unwrap();
        fs::write(&session, cumulative_line(10)).unwrap();
        fs::write(&legacy, "legacy-statistics").unwrap();
        fs::write(&path, "cache").unwrap();
        assert_eq!(usage_cache_info(&path, false).unwrap().bytes, 5);
        assert!(!legacy.exists());
        File::open(&path)
            .unwrap()
            .set_times(
                fs::FileTimes::new()
                    .set_modified(SystemTime::now() - CACHE_MAX_AGE - Duration::from_secs(1)),
            )
            .unwrap();
        assert_eq!(usage_cache_info(&path, false).unwrap().bytes, 0);
        File::create(&path)
            .unwrap()
            .set_len(MAX_CACHE_BYTES + 1)
            .unwrap();
        assert_eq!(usage_cache_info(&path, false).unwrap().bytes, 0);
        fs::write(&path, "cache").unwrap();
        assert_eq!(usage_cache_info(&path, true).unwrap().bytes, 0);
        assert_eq!(usage_cache_info(&path, true).unwrap().bytes, 0);
        assert_eq!(
            fs::read_to_string(&credentials).unwrap(),
            "synthetic-preserve"
        );
        assert!(session.exists());
    }

    #[test]
    fn bounded_cache_evicts_older_files_without_changing_full_scan_totals() {
        let root = TempDir::new().unwrap();
        let mut cache = UsageCache {
            version: USAGE_CACHE_VERSION,
            codex_home: root.path().into(),
            files: HashMap::new(),
        };
        for i in 0..4 {
            let path = root.path().join(format!("{i}.jsonl"));
            fs::write(&path, cumulative_line(10)).unwrap();
            File::open(&path)
                .unwrap()
                .set_times(
                    fs::FileTimes::new()
                        .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(i)),
                )
                .unwrap();
            cache.update_file(&path).unwrap();
        }
        let full = cached_total(&cache);
        let decoded_len = serde_json::to_vec(&cache).unwrap().len() as u64;
        let bytes = bounded_cache_bytes(&mut cache, 1024, decoded_len * 3 / 4).unwrap();
        assert!(bytes.len() <= 1024);
        let mut decoded = Vec::new();
        GzDecoder::new(bytes.as_slice())
            .read_to_end(&mut decoded)
            .unwrap();
        assert!(decoded.len() as u64 <= decoded_len * 3 / 4);
        let loaded: UsageCache = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(full, 40);
        assert_eq!(loaded.files.len(), 2);
        assert!(loaded.files.contains_key(&root.path().join("3.jsonl")));
        assert!(!loaded.files.contains_key(&root.path().join("0.jsonl")));
    }

    #[test]
    fn cache_prunes_expired_events_even_when_session_is_unchanged() {
        let root = TempDir::new().unwrap();
        fs::create_dir(root.path().join("sessions")).unwrap();
        let path = root.path().join("sessions/session.jsonl");
        fs::write(&path, cumulative_line(10)).unwrap();
        let mut cache = UsageCache::default();
        cache.update_file(&path).unwrap();
        let today = Local::now().date_naive();
        let later = today
            .checked_add_days(Days::new(FILE_SCAN_GRACE_DAYS + 1))
            .unwrap();
        assert!(cache.refresh(root.path(), later));
        assert!(cache.files[&path].events.is_empty());
    }

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
            &ProviderCatalog::default(),
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
            &ProviderCatalog::default(),
            NaiveDate::from_ymd_opt(2026, 8, 24).unwrap(),
        );
        assert_eq!(stats.thirty_days.total_tokens, 170);
        assert_eq!(stats.unassigned.total_tokens, 170);
    }

    // 核心保证：归属依据是会话文件自带的 model_provider，逐会话精确，
    // 而不是靠时间戳推断。两个文件同一时间段发生，也必须分到不同提供方。
    #[test]
    fn attributes_usage_by_session_model_provider() {
        let root = TempDir::new().unwrap();
        // collect_recent_session_files 只扫 FILE_SCAN_GRACE_DAYS 内修改过的文件，
        // 所以用例必须用当天日期，否则会话文件会被整批跳过、聚合结果为空。
        let today = Local::now().date_naive();
        let day = today.format("%Y-%m-%d").to_string();
        let sessions = root.path().join("sessions").join(&day);
        fs::create_dir_all(&sessions).unwrap();
        let event_time = |hour: u32| {
            Local
                .with_ymd_and_hms(today.year(), today.month(), today.day(), hour, 0, 0)
                .unwrap()
                .format("%Y-%m-%dT%H:%M:%S%:z")
                .to_string()
        };

        // OpenAI 与第三方会话发生在同一天的相邻时段。元数据故意写在
        // token_count 之后，保证单遍扫描不依赖 session_meta 位于首行。
        let mut openai = File::create(sessions.join("openai.jsonl")).unwrap();
        write_event(
            &mut openai,
            &event_time(1),
            json!({
                "last_token_usage": {"input_tokens": 80, "output_tokens": 20, "total_tokens": 100},
                "total_token_usage": {"input_tokens": 80, "output_tokens": 20, "total_tokens": 100}
            }),
        );
        writeln!(
            openai,
            "{}",
            json!({
                "timestamp": event_time(1),
                "type": "session_meta",
                "payload": {"model_provider": "openai", "instructions": "ignored"}
            })
        )
        .unwrap();

        let mut third = File::create(sessions.join("third.jsonl")).unwrap();
        writeln!(
            third,
            "{}",
            json!({
                "timestamp": event_time(2),
                "type": "session_meta",
                "payload": {"model_provider": "custom"}
            })
        )
        .unwrap();
        write_event(
            &mut third,
            &event_time(2),
            json!({
                "last_token_usage": {"input_tokens": 200, "output_tokens": 50, "total_tokens": 250},
                "total_token_usage": {"input_tokens": 200, "output_tokens": 50, "total_tokens": 250}
            }),
        );

        let catalog = catalog_with(&[(
            "custom",
            Some("Local Relay"),
            Some("https://relay.example.com/v1"),
        )]);
        let stats = scan_local_usage_for_date(root.path(), &[], &[], &catalog, today);

        let openai_usage = stats
            .by_provider
            .iter()
            .find(|usage| usage.kind == ModelProviderKind::Openai)
            .expect("openai provider");
        let third_usage = stats
            .by_provider
            .iter()
            .find(|usage| usage.kind == ModelProviderKind::ThirdParty)
            .expect("third-party provider");

        assert_eq!(openai_usage.tokens.total_tokens, 100);
        assert_eq!(third_usage.tokens.total_tokens, 250);
        assert_eq!(third_usage.label, "Local Relay");
        assert_eq!(third_usage.host.as_deref(), Some("relay.example.com"));
        // model_provider 不能证明认证或最终计费方式。
        assert_eq!(stats.thirty_days.total_tokens, 350);
    }

    // 会话文件缺少 model_provider 时归入未识别，不能猜测提供方或计费方式。
    #[test]
    fn session_without_model_provider_is_unattributed() {
        let root = TempDir::new().unwrap();
        let today = Local::now().date_naive();
        let sessions = root
            .path()
            .join("sessions")
            .join(today.format("%Y-%m-%d").to_string());
        fs::create_dir_all(&sessions).unwrap();
        let stamp = Local
            .with_ymd_and_hms(today.year(), today.month(), today.day(), 1, 0, 0)
            .unwrap()
            .format("%Y-%m-%dT%H:%M:%S%:z")
            .to_string();

        let mut file = File::create(sessions.join("session.jsonl")).unwrap();
        writeln!(
            file,
            "{}",
            json!({"timestamp": stamp, "type": "session_meta", "payload": {}})
        )
        .unwrap();
        write_event(
            &mut file,
            &stamp,
            json!({
                "last_token_usage": {"input_tokens": 40, "output_tokens": 10, "total_tokens": 50},
                "total_token_usage": {"input_tokens": 40, "output_tokens": 10, "total_tokens": 50}
            }),
        );

        let stats =
            scan_local_usage_for_date(root.path(), &[], &[], &ProviderCatalog::default(), today);
        let unattributed = stats
            .by_provider
            .iter()
            .find(|usage| usage.kind == ModelProviderKind::Unattributed)
            .expect("unattributed provider");
        assert_eq!(unattributed.tokens.total_tokens, 50);
    }

    // host 只取主机与端口，不回传完整 base_url，避免把服务地址细节送进前端。
    #[test]
    fn host_extraction_drops_path_and_scheme() {
        assert_eq!(
            host_of("http://127.0.0.1:8080/v1"),
            Some("127.0.0.1:8080".to_string())
        );
        assert_eq!(
            host_of("https://api.example.com/v1?x=1"),
            Some("api.example.com".to_string())
        );
        assert_eq!(host_of(""), None);
    }

    fn catalog_with(entries: &[(&str, Option<&str>, Option<&str>)]) -> ProviderCatalog {
        let mut table = toml::Table::new();
        let mut providers = toml::Table::new();
        for (id, name, base_url) in entries {
            let mut entry = toml::Table::new();
            if let Some(name) = name {
                entry.insert("name".to_string(), toml::Value::String(name.to_string()));
            }
            if let Some(base_url) = base_url {
                entry.insert(
                    "base_url".to_string(),
                    toml::Value::String(base_url.to_string()),
                );
            }
            providers.insert(id.to_string(), toml::Value::Table(entry));
        }
        table.insert("model_providers".to_string(), toml::Value::Table(providers));
        ProviderCatalog::from_config(&table)
    }
}
