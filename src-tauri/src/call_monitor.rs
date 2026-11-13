//! 本机会话记录兼容层。只提取执行元数据，不保存正文、参数、输出或凭据。
//! JSONL 是客户端内部格式；未知事件不解释为成功，外层调用不与执行事件累加。
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, Metadata},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::SystemTime,
};

#[cfg(test)]
const WINDOW_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_FILES: usize = 64;
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 1024 * 1024;
const MAX_FILE_CALLS: usize = 1000;
const MAX_CALLS: usize = 5000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MonitorSettings {
    pub window_hours: u32,
    pub read_depth_mi_b: u32,
    pub max_files: usize,
    pub max_calls_per_file: usize,
    pub max_calls: usize,
    pub max_line_mi_b: u32,
}

impl Default for MonitorSettings {
    fn default() -> Self {
        Self {
            window_hours: 24,
            read_depth_mi_b: 8,
            max_files: MAX_FILES,
            max_calls_per_file: MAX_FILE_CALLS,
            max_calls: MAX_CALLS,
            max_line_mi_b: 1,
        }
    }
}

impl MonitorSettings {
    pub fn normalized(self) -> Self {
        let read_depth_mi_b = self.read_depth_mi_b.clamp(1, 64);
        Self {
            window_hours: self.window_hours.clamp(1, 720),
            read_depth_mi_b,
            max_files: self.max_files.clamp(1, 256),
            max_calls_per_file: self.max_calls_per_file.clamp(1, 5000),
            max_calls: self.max_calls.clamp(1, 20000),
            max_line_mi_b: self.max_line_mi_b.clamp(1, 8.min(read_depth_mi_b)),
        }
    }

    fn window_ms(self) -> u64 {
        u64::from(self.window_hours) * 60 * 60 * 1000
    }

    fn read_bytes(self) -> u64 {
        u64::from(self.read_depth_mi_b) * 1024 * 1024
    }

    fn line_bytes(self) -> usize {
        self.max_line_mi_b as usize * 1024 * 1024
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Coverage {
    pub eligible_files: usize,
    pub omitted_files: usize,
    pub depth_limited_files: usize,
    pub retention_limited_files: usize,
    pub omitted_calls: usize,
    pub invalid_lines: usize,
    pub oversized_lines: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolKind {
    Command,
    FileChange,
    Mcp,
    Search,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CallStatus {
    Completed,
    Failed,
    Cancelled,
    Pending,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CallSource {
    ExecutionEvent,
    CallRecord,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub tool_id: String,
    pub kind: ToolKind,
    pub status: CallStatus,
    pub source: CallSource,
    pub observed_at_ms: u64,
    pub started_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub duration_ms: Option<u64>,
    pub exit_code: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: Option<String>,
    pub project: Option<String>,
    pub started_at_ms: Option<u64>,
    pub last_observed_at_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub settings: MonitorSettings,
    pub coverage: Coverage,
    pub calls: Vec<ToolCall>,
    pub sessions: Vec<Session>,
    pub generated_at_ms: u64,
    pub window_start_ms: u64,
    pub files_scanned: usize,
    pub unreadable_files: usize,
    pub skipped_lines: usize,
    pub limited: bool,
}

#[derive(Default)]
pub struct MonitorCache {
    home: PathBuf,
    files: HashMap<PathBuf, CachedFile>,
    labels: Option<SessionLabels>,
    settings: MonitorSettings,
}

struct SessionLabels {
    len: u64,
    modified: Option<SystemTime>,
    identity: (u64, u64),
    titles: HashMap<String, String>,
}

struct CachedFile {
    settings: MonitorSettings,
    session: Session,
    turn_id: Option<String>,
    len: u64,
    modified: Option<SystemTime>,
    identity: (u64, u64),
    offset: u64,
    discard_partial_line: bool,
    boundary: Vec<u8>,
    calls: HashMap<String, ToolCall>,
    fallback: HashMap<String, ToolCall>,
    depth_limited: bool,
    retention_dropped_at_ms: [u64; 2],
    invalid_lines: usize,
    oversized_lines: usize,
}

// 原始标识只用于本地关联；展示名称由单独的受限元数据入口提供。
fn identifier(domain: &str, value: &str) -> String {
    let digest = Sha256::digest(format!("{domain}\0{value}").as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

// 只接收显式会话名称和目录末级名称，绝不从正文、命令或工具输出推导名称。
// 含疑似凭据的整个标签丢弃；先检查全文再截短，避免泄露凭据前缀。
fn safe_label(value: &str) -> Option<String> {
    if value.len() > 4096
        || value.chars().any(|c| {
            (c.is_control() && !c.is_whitespace())
                || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')
        })
    {
        return None;
    }
    let compact: String = value
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '\'' | '"' | '`'))
        .collect::<String>()
        .to_ascii_lowercase();
    let lower = value.to_ascii_lowercase();
    if [
        "sk-",
        "sess-",
        "eyj",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
        "aiza",
    ]
    .iter()
    .any(|prefix| {
        lower
            .split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')))
            .any(|part| part.starts_with(prefix))
    }) || [
        "bearer",
        "-----begin",
        "http://",
        "https://",
        "access_token",
        "refresh_token",
        "id_token",
        "apikey",
        "api_key",
        "password",
        "passwd",
        "密码",
        "密钥",
        "令牌",
    ]
    .iter()
    .any(|prefix| compact.contains(prefix))
        || lower.contains("basic ")
        || [
            "token",
            "key",
            "secret",
            "password",
            "passwd",
            "authorization",
            "cookie",
            "密码",
            "密钥",
            "令牌",
        ]
        .iter()
        .any(|key| {
            ["=", ":", "："]
                .iter()
                .any(|sep| compact.contains(&format!("{key}{sep}")))
        })
        || value
            .split(|c: char| {
                !(c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '+' | '='))
            })
            .any(|part| part.len() >= 32)
    {
        return None;
    }
    let clean = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() {
        return None;
    }
    let mut label: String = clean.chars().take(96).collect();
    if clean.chars().count() > 96 {
        label.push('…');
    }
    Some(label)
}

fn project_label(cwd: &str) -> Option<String> {
    // 两种路径分隔符均支持，但绝不把完整路径或用户名目录作为前缀传给前端。
    let name = cwd
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()?;
    if matches!(name, "." | ".." | "~") {
        return None;
    }
    safe_label(name)
}

impl SessionLabels {
    fn read(path: &Path, metadata: &Metadata) -> io::Result<Self> {
        let mut file = File::open(path)?;
        let start = metadata.len().saturating_sub(MAX_READ_BYTES);
        file.seek(SeekFrom::Start(start))?;
        let mut reader = BufReader::new(file.take(MAX_READ_BYTES));
        if start > 0 {
            // 有界读取索引尾部；丢弃被截断的首行。
            bounded_line(&mut reader, MAX_LINE_BYTES)?;
        }
        let mut titles = HashMap::new();
        loop {
            let (line, _, complete) = bounded_line(&mut reader, MAX_LINE_BYTES)?;
            if !complete {
                break;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            let Some(id) = value["id"].as_str() else {
                continue;
            };
            let id = identifier("session", id);
            if let Some(title) = value["thread_name"].as_str().and_then(safe_label) {
                // 索引为追加记录，最后一条名称覆盖旧名称。
                titles.insert(id, title);
            } else {
                titles.remove(&id);
            }
        }
        Ok(Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            identity: file_identity(metadata),
            titles,
        })
    }
}

fn file_identity(metadata: &Metadata) -> (u64, u64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        (0, 0)
    }
}

fn timestamp(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value.as_u64().or_else(|| {
        DateTime::parse_from_rfc3339(value.as_str()?)
            .ok()?
            .timestamp_millis()
            .try_into()
            .ok()
    })
}

// 返回完整行和已消费字节数；超长行丢弃，未写完的尾行留到下次。
fn bounded_line(reader: &mut impl BufRead, max_bytes: usize) -> io::Result<(Vec<u8>, u64, bool)> {
    let mut line = Vec::new();
    let mut length = 0u64;
    let mut oversized = false;
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return Ok((line, length, false));
        }
        let newline = bytes.iter().position(|byte| *byte == b'\n');
        let count = newline.map_or(bytes.len(), |index| index + 1);
        length += count as u64;
        if !oversized && line.len() + count <= max_bytes {
            line.extend_from_slice(&bytes[..count]);
        } else {
            oversized = true;
            line.clear();
        }
        reader.consume(count);
        if newline.is_some() {
            return Ok((line, length, true));
        }
    }
}

fn boundary(file: &mut File, offset: u64) -> io::Result<Vec<u8>> {
    let length = offset.min(256);
    file.seek(SeekFrom::Start(offset - length))?;
    let mut bytes = vec![0; length as usize];
    file.read_exact(&mut bytes)?;
    // 缓存只持有摘要，不保留可能含敏感正文的边界字节。
    Ok(Sha256::digest(bytes).to_vec())
}

impl CachedFile {
    fn new(
        path: &Path,
        file: &mut File,
        metadata: &Metadata,
        settings: MonitorSettings,
    ) -> io::Result<Self> {
        file.seek(SeekFrom::Start(0))?;
        let (line, _, complete) = bounded_line(
            &mut BufReader::new((&mut *file).take(MAX_READ_BYTES)),
            MAX_LINE_BYTES,
        )?;
        let event = complete
            .then(|| serde_json::from_slice::<Value>(&line).ok())
            .flatten();
        let meta = event
            .as_ref()
            .filter(|e| e["type"] == "session_meta")
            .map(|e| &e["payload"]);
        let fallback = path.to_string_lossy();
        let session_id = meta.and_then(|m| m["id"].as_str());
        Ok(Self {
            settings,
            session: Session {
                id: identifier("session", session_id.unwrap_or(&fallback)),
                parent_id: meta
                    .and_then(|m| {
                        m["parent_thread_id"].as_str().or_else(|| {
                            m.pointer("/source/subagent/thread_spawn/parent_thread_id")
                                .and_then(Value::as_str)
                        })
                    })
                    .map(|id| identifier("session", id)),
                title: None,
                project: meta.and_then(|m| m["cwd"].as_str()).and_then(project_label),
                started_at_ms: timestamp(meta.and_then(|m| m.get("timestamp")))
                    .or_else(|| timestamp(event.as_ref().and_then(|e| e.get("timestamp")))),
                last_observed_at_ms: 0,
            },
            turn_id: None,
            len: metadata.len(),
            modified: metadata.modified().ok(),
            identity: file_identity(metadata),
            offset: 0,
            discard_partial_line: false,
            boundary: Vec::new(),
            calls: HashMap::new(),
            fallback: HashMap::new(),
            depth_limited: false,
            retention_dropped_at_ms: [0, 0],
            invalid_lines: 0,
            oversized_lines: 0,
        })
    }

    fn update(&mut self, file: &mut File, metadata: &Metadata, now: u64) -> io::Result<()> {
        let end = metadata.len();
        if end.saturating_sub(self.offset) > self.settings.read_bytes() {
            self.offset = end - self.settings.read_bytes();
            self.depth_limited = true;
            // 起点恰好在换行边界时保留该行；否则只丢弃被截断的首行。
            file.seek(SeekFrom::Start(self.offset - 1))?;
            let mut previous = [0];
            file.read_exact(&mut previous)?;
            self.discard_partial_line = previous[0] != b'\n';
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut reader = BufReader::new((&mut *file).take(end - self.offset));
        if self.discard_partial_line {
            let (_, length, complete) = bounded_line(&mut reader, self.settings.line_bytes())?;
            self.offset += length;
            // 被截断的记录可能还在写入，下一次继续丢弃到换行，避免误报格式错误。
            self.discard_partial_line = !complete;
        }
        loop {
            let (line, length, complete) = bounded_line(&mut reader, self.settings.line_bytes())?;
            if !complete {
                break;
            }
            self.offset += length;
            if line.is_empty() && length > self.settings.line_bytes() as u64 {
                self.oversized_lines += 1;
            } else {
                match serde_json::from_slice::<Value>(&line) {
                    Ok(event) => self.observe(&event, now),
                    Err(_) => self.invalid_lines += 1,
                }
            }
        }
        drop(reader);
        self.boundary = boundary(file, self.offset)?;
        self.len = end;
        self.modified = metadata.modified().ok();
        for (source, calls) in [&mut self.calls, &mut self.fallback]
            .into_iter()
            .enumerate()
        {
            calls.retain(|_, call| {
                call.observed_at_ms >= now.saturating_sub(self.settings.window_ms())
            });
            if calls.len() > self.settings.max_calls_per_file {
                let mut latest: Vec<_> = calls
                    .values()
                    .map(|call| (call.observed_at_ms, call.id.clone()))
                    .collect();
                latest.sort_unstable();
                for (time, id) in latest
                    .into_iter()
                    .take(calls.len() - self.settings.max_calls_per_file)
                {
                    calls.remove(&id);
                    self.retention_dropped_at_ms[source] =
                        self.retention_dropped_at_ms[source].max(time);
                }
            }
        }
        Ok(())
    }

    fn observe(&mut self, event: &Value, now: u64) {
        let payload = &event["payload"];
        let outer_time = timestamp(event.get("timestamp"));
        let observed = timestamp(payload.get("completed_at_ms"))
            .or(outer_time)
            .or_else(|| timestamp(payload.get("started_at_ms")));
        let Some(observed) = observed.filter(|time| {
            *time >= now.saturating_sub(self.settings.window_ms())
                && *time <= now.saturating_add(60_000)
        }) else {
            return;
        };
        self.session.last_observed_at_ms = self.session.last_observed_at_ms.max(observed);
        if let Some(id) = payload["turn_id"].as_str() {
            self.turn_id = Some(identifier("turn", id));
        }
        let turn_id = self.turn_id.clone();
        if event["type"] == "event_msg"
            && matches!(
                payload["type"].as_str(),
                Some("item_started" | "item_completed")
            )
        {
            let item = &payload["item"];
            let kind = match item["type"].as_str() {
                Some("CommandExecution" | "commandExecution") => ToolKind::Command,
                Some("FileChange" | "fileChange") => ToolKind::FileChange,
                Some("McpToolCall" | "mcpToolCall") => ToolKind::Mcp,
                Some("WebSearch" | "webSearch") => ToolKind::Search,
                Some("Extension")
                    if matches!(
                        item["kind"].as_str(),
                        Some("web.search" | "web.open" | "web.find")
                    ) =>
                {
                    ToolKind::Search
                }
                Some("DynamicToolCall" | "dynamicToolCall") => ToolKind::Other,
                _ => return,
            };
            let Some(item_id) = item["id"].as_str() else {
                return;
            };
            let id = identifier(
                &format!("{}:{}", self.session.id, turn_id.as_deref().unwrap_or("")),
                item_id,
            );
            let finished = payload["type"] == "item_completed";
            let exit_code = item["exit_code"]
                .as_i64()
                .or_else(|| item["exitCode"].as_i64());
            let status = if matches!(
                item["status"].as_str(),
                Some("declined" | "cancelled" | "canceled" | "interrupted")
            ) {
                CallStatus::Cancelled
            } else if item.pointer("/result/isError").and_then(Value::as_bool) == Some(true)
                || item["error"].is_object()
                || exit_code.is_some_and(|code| code != 0)
            {
                CallStatus::Failed
            } else {
                match item["status"].as_str() {
                    Some("failed" | "error") => CallStatus::Failed,
                    Some("completed") if finished => CallStatus::Completed,
                    _ if !finished => CallStatus::Pending,
                    None if kind == ToolKind::Search => CallStatus::Completed,
                    _ => CallStatus::Unknown,
                }
            };
            let previous = self.calls.get(&id);
            if !finished && previous.is_some_and(|call| call.completed_at_ms.is_some()) {
                return;
            }
            let started = timestamp(payload.get("started_at_ms"))
                .or_else(|| previous.and_then(|call| call.started_at_ms))
                .or_else(|| (!finished).then_some(observed));
            let completed =
                finished.then_some(timestamp(payload.get("completed_at_ms")).unwrap_or(observed));
            let duration = finished
                .then(|| {
                    item["durationMs"]
                        .as_u64()
                        .or_else(|| item["duration_ms"].as_u64())
                        .or_else(|| {
                            let seconds = item.pointer("/duration/secs")?.as_u64()?;
                            let nanos = item.pointer("/duration/nanos")?.as_u64()?;
                            seconds.checked_mul(1000)?.checked_add(nanos / 1_000_000)
                        })
                        .or_else(|| completed?.checked_sub(started?))
                })
                .flatten();
            let tool_id = if kind == ToolKind::Mcp {
                identifier(
                    "tool",
                    &format!(
                        "{}\0{}",
                        item["server"].as_str().unwrap_or(""),
                        item["tool"].as_str().unwrap_or("")
                    ),
                )
            } else {
                format!("{kind:?}").to_lowercase()
            };
            self.calls.insert(
                id.clone(),
                ToolCall {
                    id,
                    session_id: self.session.id.clone(),
                    turn_id,
                    tool_id,
                    kind,
                    status,
                    source: CallSource::ExecutionEvent,
                    observed_at_ms: observed,
                    started_at_ms: started,
                    completed_at_ms: completed,
                    duration_ms: duration,
                    exit_code: (kind == ToolKind::Command).then_some(exit_code).flatten(),
                },
            );
        } else if event["type"] == "response_item" {
            let Some(call_id) = payload["call_id"].as_str() else {
                return;
            };
            let id = identifier(&self.session.id, call_id);
            match payload["type"].as_str() {
                Some("function_call" | "custom_tool_call") => {
                    let name = payload["name"].as_str().unwrap_or("");
                    let kind = match name {
                        "exec_command" | "shell" | "shell_command" | "write_stdin" => {
                            ToolKind::Command
                        }
                        "apply_patch" => ToolKind::FileChange,
                        "web_search" => ToolKind::Search,
                        _ if name.starts_with("mcp__") => ToolKind::Mcp,
                        _ => ToolKind::Other,
                    };
                    // response_item.status 表示模型生成已结束，不代表工具执行成功。
                    self.fallback.entry(id.clone()).or_insert(ToolCall {
                        id,
                        session_id: self.session.id.clone(),
                        turn_id,
                        tool_id: identifier("tool", name),
                        kind,
                        status: CallStatus::Pending,
                        source: CallSource::CallRecord,
                        observed_at_ms: observed,
                        started_at_ms: Some(observed),
                        completed_at_ms: None,
                        duration_ms: None,
                        exit_code: None,
                    });
                }
                Some("function_call_output" | "custom_tool_call_output") => {
                    if let Some(call) = self.fallback.get_mut(&id) {
                        call.status = CallStatus::Completed;
                        call.completed_at_ms = Some(observed);
                        call.observed_at_ms = observed;
                    }
                }
                _ => {}
            }
        }
    }
}

fn collect_files(
    dir: &Path,
    depth: usize,
    cutoff: SystemTime,
    files: &mut Vec<(PathBuf, Metadata)>,
    unreadable: &mut usize,
) {
    match fs::symlink_metadata(dir) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            *unreadable += 1;
            return;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return,
        Err(_) => {
            *unreadable += 1;
            return;
        }
        _ => {}
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => {
            *unreadable += 1;
            return;
        }
    };
    for entry in entries {
        let Ok(entry) = entry else {
            *unreadable += 1;
            continue;
        };
        let Ok(kind) = entry.file_type() else {
            *unreadable += 1;
            continue;
        };
        let path = entry.path();
        if kind.is_dir() && depth > 0 {
            collect_files(&path, depth - 1, cutoff, files, unreadable);
        } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
            match entry.metadata() {
                Ok(meta) if meta.modified().map_or(true, |modified| modified >= cutoff) => {
                    files.push((path, meta))
                }
                Err(_) => *unreadable += 1,
                _ => {}
            }
        }
    }
}

impl MonitorCache {
    #[cfg(test)]
    pub fn snapshot(&mut self, home: &Path, now: u64) -> Snapshot {
        self.snapshot_with_settings(home, now, MonitorSettings::default())
    }

    pub fn snapshot_with_settings(
        &mut self,
        home: &Path,
        now: u64,
        settings: MonitorSettings,
    ) -> Snapshot {
        let settings = settings.normalized();
        if self.home != home || self.settings != settings {
            self.files.clear();
            self.labels = None;
            self.home = home.to_path_buf();
            self.settings = settings;
        }
        let index = home.join("session_index.jsonl");
        // 名称是可选信息；索引缺失或不可读时仍可按项目和时间识别会话。
        if let Some(metadata) = fs::symlink_metadata(&index).ok().filter(|m| m.is_file()) {
            if !self.labels.as_ref().is_some_and(|labels| {
                labels.len == metadata.len()
                    && labels.modified == metadata.modified().ok()
                    && labels.identity == file_identity(&metadata)
            }) {
                self.labels = SessionLabels::read(&index, &metadata).ok();
            }
        } else {
            self.labels = None;
        }
        let mut candidates = Vec::new();
        let mut unreadable_files = 0;
        let cutoff = SystemTime::UNIX_EPOCH
            + std::time::Duration::from_millis(now.saturating_sub(self.settings.window_ms()));
        collect_files(
            &home.join("sessions"),
            3,
            cutoff,
            &mut candidates,
            &mut unreadable_files,
        );
        collect_files(
            &home.join("archived_sessions"),
            1,
            cutoff,
            &mut candidates,
            &mut unreadable_files,
        );
        candidates.sort_by(|a, b| {
            b.1.modified()
                .ok()
                .cmp(&a.1.modified().ok())
                .then_with(|| a.0.cmp(&b.0))
        });
        let mut coverage = Coverage {
            eligible_files: candidates.len(),
            omitted_files: candidates.len().saturating_sub(settings.max_files),
            ..Coverage::default()
        };
        candidates.truncate(settings.max_files);
        let paths: HashSet<_> = candidates.iter().map(|(path, _)| path.clone()).collect();
        self.files.retain(|path, _| paths.contains(path));
        let mut files_scanned = 0;
        for (path, metadata) in candidates {
            let result = (|| -> io::Result<()> {
                if self.files.get(&path).is_some_and(|cache| {
                    cache.len == metadata.len()
                        && cache.modified == metadata.modified().ok()
                        && cache.identity == file_identity(&metadata)
                }) {
                    return Ok(());
                }
                let mut file = File::open(&path)?;
                let append = match self.files.get(&path) {
                    Some(cache)
                        if cache.identity == file_identity(&metadata)
                            && metadata.len() > cache.len =>
                    {
                        boundary(&mut file, cache.offset)? == cache.boundary
                    }
                    _ => false,
                };
                if !append {
                    self.files.insert(
                        path.clone(),
                        CachedFile::new(&path, &mut file, &metadata, settings)?,
                    );
                }
                if let Some(cache) = self.files.get_mut(&path) {
                    cache.update(&mut file, &metadata, now)?;
                }
                Ok(())
            })();
            if result.is_err() {
                unreadable_files += 1;
                self.files.remove(&path);
            } else {
                files_scanned += 1;
            }
        }
        let mut calls = HashMap::new();
        let mut sessions = HashMap::new();
        let execution_sessions: HashSet<_> = self
            .files
            .values()
            .filter(|cache| {
                cache.calls.values().any(|call| {
                    call.observed_at_ms >= now.saturating_sub(self.settings.window_ms())
                })
            })
            .map(|cache| cache.session.id.as_str())
            .collect();
        for cache in self.files.values() {
            coverage.depth_limited_files += usize::from(cache.depth_limited);
            coverage.invalid_lines += cache.invalid_lines;
            coverage.oversized_lines += cache.oversized_lines;
            sessions.insert(cache.session.id.clone(), cache.session.clone());
            let uses_execution = execution_sessions.contains(cache.session.id.as_str());
            let dropped_at = cache.retention_dropped_at_ms[usize::from(!uses_execution)];
            coverage.retention_limited_files += usize::from(
                dropped_at > 0 && dropped_at >= now.saturating_sub(settings.window_ms()),
            );
            let source = if uses_execution {
                &cache.calls
            } else {
                &cache.fallback
            };
            for call in source
                .values()
                .filter(|call| call.observed_at_ms >= now.saturating_sub(self.settings.window_ms()))
            {
                let previous = calls.get(&call.id);
                if previous.is_none_or(|old: &ToolCall| {
                    call.observed_at_ms > old.observed_at_ms
                        || (call.observed_at_ms == old.observed_at_ms
                            && call.completed_at_ms.is_some()
                            && old.completed_at_ms.is_none())
                }) {
                    calls.insert(call.id.clone(), call.clone());
                }
            }
        }
        let mut calls: Vec<_> = calls.into_values().collect();
        calls.sort_by(|a, b| {
            b.observed_at_ms
                .cmp(&a.observed_at_ms)
                .then_with(|| a.id.cmp(&b.id))
        });
        coverage.omitted_calls = calls.len().saturating_sub(settings.max_calls);
        calls.truncate(settings.max_calls);
        let ids: HashSet<_> = calls.iter().map(|call| call.session_id.as_str()).collect();
        let parents: HashSet<_> = sessions
            .values()
            .filter(|session| ids.contains(session.id.as_str()))
            .filter_map(|session| session.parent_id.as_deref())
            .collect();
        let keep: HashSet<_> = ids.into_iter().chain(parents).map(str::to_string).collect();
        let mut sessions: Vec<_> = sessions
            .into_values()
            .filter(|session| keep.contains(&session.id))
            .collect();
        for session in &mut sessions {
            session.title = self
                .labels
                .as_ref()
                .and_then(|labels| labels.titles.get(&session.id))
                .cloned();
        }
        sessions.sort_by(|a, b| {
            b.last_observed_at_ms
                .cmp(&a.last_observed_at_ms)
                .then_with(|| a.id.cmp(&b.id))
        });
        Snapshot {
            settings,
            limited: coverage.omitted_files > 0
                || coverage.depth_limited_files > 0
                || coverage.retention_limited_files > 0
                || coverage.omitted_calls > 0,
            skipped_lines: coverage.invalid_lines + coverage.oversized_lines,
            coverage,
            calls,
            sessions,
            generated_at_ms: now,
            window_start_ms: now.saturating_sub(self.settings.window_ms()),
            files_scanned,
            unreadable_files,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    const NOW: u64 = 1_800_000_000_000;

    fn create_session(root: &Path, name: &str, parent: Option<&str>) -> PathBuf {
        let dir = root.join("sessions");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{name}.jsonl"));
        append(
            &path,
            json!({"type":"session_meta", "timestamp":NOW-5000, "payload":{
                "id":name, "parent_thread_id":parent, "cwd":"/PRIVATE_PATH/sample-dashboard", "instructions":"PRIVATE_PROMPT"
            }}),
        );
        path
    }

    fn append(path: &Path, event: Value) {
        let mut file = fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)
            .unwrap();
        writeln!(file, "{event}").unwrap();
        stamp(&file);
    }

    fn stamp(file: &File) {
        file.set_times(
            fs::FileTimes::new()
                .set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(NOW)),
        )
        .unwrap();
    }

    fn completed(id: &str, kind: &str) -> Value {
        json!({"type":"event_msg", "timestamp":NOW, "payload":{
            "type":"item_completed", "turn_id":"turn-a", "started_at_ms":NOW-1200,
            "completed_at_ms":NOW, "item":{"type":kind, "id":id, "status":"completed"}
        }})
    }

    fn completed_at(id: &str, time: u64) -> Value {
        let mut event = completed(id, "CommandExecution");
        event["timestamp"] = json!(time);
        event["payload"]["started_at_ms"] = json!(time - 100);
        event["payload"]["completed_at_ms"] = json!(time);
        event
    }

    #[test]
    fn settings_are_bounded_and_use_matching_frontend_field_names() {
        let settings: MonitorSettings = serde_json::from_value(json!({
            "windowHours":0, "readDepthMiB":2, "maxFiles":9999,
            "maxCallsPerFile":0, "maxCalls":999999, "maxLineMiB":9
        }))
        .unwrap();
        let settings = settings.normalized();
        assert_eq!(settings.window_hours, 1);
        assert_eq!(settings.read_depth_mi_b, 2);
        assert_eq!(settings.max_files, 256);
        assert_eq!(settings.max_calls_per_file, 1);
        assert_eq!(settings.max_calls, 20000);
        assert_eq!(settings.max_line_mi_b, 2);
        let serialized = serde_json::to_value(settings).unwrap();
        assert_eq!(serialized["readDepthMiB"], 2);
        assert_eq!(serialized["maxLineMiB"], 2);
    }

    #[test]
    fn time_window_changes_rescan_unchanged_files_and_keep_latest_calls() {
        let root = tempfile::tempdir().unwrap();
        let path = create_session(root.path(), "session", None);
        append(&path, completed_at("older", NOW - 2 * 3_600_000));
        append(&path, completed_at("recent", NOW - 1000));
        let mut cache = MonitorCache::default();
        let mut settings = MonitorSettings {
            window_hours: 1,
            ..MonitorSettings::default()
        };
        let snapshot = cache.snapshot_with_settings(root.path(), NOW, settings);
        assert_eq!(snapshot.calls.len(), 1);
        assert_eq!(snapshot.window_start_ms, NOW - 3_600_000);
        settings.window_hours = 6;
        let snapshot = cache.snapshot_with_settings(root.path(), NOW, settings);
        assert_eq!(snapshot.calls.len(), 2);
        assert_eq!(snapshot.calls[0].observed_at_ms, NOW - 1000);
        settings.max_calls = 1;
        let snapshot = cache.snapshot_with_settings(root.path(), NOW, settings);
        assert_eq!(snapshot.calls.len(), 1);
        assert_eq!(snapshot.calls[0].observed_at_ms, NOW - 1000);
        assert_eq!(snapshot.coverage.omitted_calls, 1);
        assert_eq!(snapshot.coverage.retention_limited_files, 0);
        settings.max_calls = 10;
        settings.max_calls_per_file = 1;
        let snapshot = cache.snapshot_with_settings(root.path(), NOW, settings);
        assert_eq!(snapshot.calls[0].observed_at_ms, NOW - 1000);
        assert_eq!(snapshot.coverage.retention_limited_files, 1);
        assert_eq!(snapshot.coverage.omitted_calls, 0);
        settings.window_hours = 1;
        let snapshot = cache.snapshot_with_settings(root.path(), NOW, settings);
        assert_eq!(snapshot.calls.len(), 1);
        assert!(!snapshot.limited);
    }

    #[test]
    fn file_limit_selects_recently_updated_files_and_reports_only_omitted_candidates() {
        let root = tempfile::tempdir().unwrap();
        for (name, age) in [("old", 2 * 3_600_000), ("middle", 3000), ("new", 1000)] {
            let path = create_session(root.path(), name, None);
            append(&path, completed_at("call", NOW - age));
            File::open(path)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(
                    SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(NOW - age),
                ))
                .unwrap();
        }
        let mut cache = MonitorCache::default();
        let mut settings = MonitorSettings {
            window_hours: 1,
            max_files: 1,
            ..MonitorSettings::default()
        };
        let snapshot = cache.snapshot_with_settings(root.path(), NOW, settings);
        assert_eq!(snapshot.calls.len(), 1);
        assert_eq!(snapshot.calls[0].session_id, identifier("session", "new"));
        assert_eq!(snapshot.coverage.eligible_files, 2);
        assert_eq!(snapshot.coverage.omitted_files, 1);
        settings.max_files = 2;
        let snapshot = cache.snapshot_with_settings(root.path(), NOW, settings);
        assert_eq!(snapshot.calls.len(), 2);
        assert_eq!(snapshot.coverage.omitted_files, 0);
    }

    #[test]
    fn increasing_depth_recovers_earlier_calls_without_counting_the_cut_line_as_invalid() {
        let root = tempfile::tempdir().unwrap();
        let path = create_session(root.path(), "session", None);
        append(&path, completed_at("earlier", NOW - 1000));
        for _ in 0..30 {
            append(&path, json!({"type":"ignored", "text":"x".repeat(50_000)}));
        }
        append(&path, completed_at("latest", NOW));
        let mut cache = MonitorCache::default();
        let mut settings = MonitorSettings {
            read_depth_mi_b: 1,
            ..MonitorSettings::default()
        };
        let snapshot = cache.snapshot_with_settings(root.path(), NOW, settings);
        assert_eq!(snapshot.calls.len(), 1);
        assert_eq!(snapshot.coverage.depth_limited_files, 1);
        assert_eq!(snapshot.skipped_lines, 0);
        settings.read_depth_mi_b = 2;
        let snapshot = cache.snapshot_with_settings(root.path(), NOW, settings);
        assert_eq!(snapshot.calls.len(), 2);
        assert_eq!(snapshot.coverage.depth_limited_files, 0);
        assert!(!snapshot.limited);
    }

    #[test]
    fn invalid_and_oversized_records_are_separate_and_record_limit_can_be_increased() {
        let root = tempfile::tempdir().unwrap();
        let path = create_session(root.path(), "session", None);
        let mut event = completed("large", "CommandExecution");
        event["payload"]["item"]["aggregated_output"] = json!("x".repeat(MAX_LINE_BYTES + 100));
        append(&path, event);
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "invalid").unwrap();
        stamp(&file);
        let mut cache = MonitorCache::default();
        let snapshot = cache.snapshot(root.path(), NOW);
        assert_eq!(snapshot.coverage.oversized_lines, 1);
        assert_eq!(snapshot.coverage.invalid_lines, 1);
        assert!(snapshot.calls.is_empty());
        let settings = MonitorSettings {
            max_line_mi_b: 2,
            ..MonitorSettings::default()
        };
        let snapshot = cache.snapshot_with_settings(root.path(), NOW, settings);
        assert_eq!(snapshot.coverage.oversized_lines, 0);
        assert_eq!(snapshot.coverage.invalid_lines, 1);
        assert_eq!(snapshot.calls.len(), 1);
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("aggregated_output"));
    }

    #[test]
    fn depth_cut_through_a_growing_line_does_not_report_its_continuation_as_invalid() {
        let root = tempfile::tempdir().unwrap();
        let path = create_session(root.path(), "session", None);
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(
            file,
            "{{\"type\":\"ignored\",\"text\":\"{}",
            "x".repeat(MAX_LINE_BYTES + 100)
        )
        .unwrap();
        stamp(&file);
        let mut cache = MonitorCache::default();
        let settings = MonitorSettings {
            read_depth_mi_b: 1,
            ..MonitorSettings::default()
        };
        let snapshot = cache.snapshot_with_settings(root.path(), NOW, settings);
        assert_eq!(snapshot.coverage.depth_limited_files, 1);
        assert_eq!(snapshot.skipped_lines, 0);
        writeln!(file, "\"}}").unwrap();
        append(&path, completed("after-large-record", "CommandExecution"));
        let snapshot = cache.snapshot_with_settings(root.path(), NOW, settings);
        assert_eq!(snapshot.calls.len(), 1);
        assert_eq!(snapshot.skipped_lines, 0);
    }

    #[test]
    fn session_labels_follow_renames_and_fall_back_without_reading_conversations() {
        let root = tempfile::tempdir().unwrap();
        let path = create_session(root.path(), "session", None);
        append(&path, completed("call", "CommandExecution"));
        let index = root.path().join("session_index.jsonl");
        append(
            &index,
            json!({"id":"session","thread_name":"完善登录页面","updated_at":NOW}),
        );
        let mut cache = MonitorCache::default();
        let snapshot = cache.snapshot(root.path(), NOW);
        let session = &snapshot.sessions[0];
        assert_eq!(session.title.as_deref(), Some("完善登录页面"));
        assert_eq!(session.project.as_deref(), Some("sample-dashboard"));
        assert_eq!(session.started_at_ms, Some(NOW - 5000));
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("PRIVATE_"));

        append(
            &index,
            json!({"id":"session","thread_name":"登录页面回归检查"}),
        );
        assert_eq!(
            cache.snapshot(root.path(), NOW).sessions[0]
                .title
                .as_deref(),
            Some("登录页面回归检查")
        );
        append(
            &index,
            json!({"id":"session","thread_name":"Bearer PRIVATE_TOKEN"}),
        );
        assert!(cache.snapshot(root.path(), NOW).sessions[0].title.is_none());
        fs::remove_file(index).unwrap();
        let snapshot = cache.snapshot(root.path(), NOW);
        assert!(snapshot.sessions[0].title.is_none());
        assert_eq!(snapshot.unreadable_files, 0);
        assert_eq!(snapshot.calls.len(), 1);
    }

    #[test]
    fn display_labels_reject_credentials_before_truncating_and_only_use_project_basename() {
        for value in [
            "调试 sk-proj-example",
            "token: short-secret",
            "API Key = secret",
            "access_token short-secret",
            "Bearer short-secret",
            "Basic abc123",
            "认证 eyJhbGciOiJIUzI1NiJ9.abcdef.signature",
            "修复 ghp_example",
            "https://example.test?secret=example",
            "abcdefghijklmnopqrstuvwxyz123456",
            "密码：example",
            "隐藏\u{202e}内容",
            "隐藏\u{0}内容",
        ] {
            assert!(safe_label(value).is_none());
        }
        assert!(safe_label(&format!("{} token=secret", "安全描述".repeat(80))).is_none());
        assert_eq!(safe_label("  修复\n布局  ").as_deref(), Some("修复 布局"));
        assert_eq!(safe_label("task-runner").as_deref(), Some("task-runner"));
        assert_eq!(safe_label(&"界".repeat(200)).unwrap().chars().count(), 97);
        assert_eq!(
            project_label("/PRIVATE_PATH/sample-dashboard/").as_deref(),
            Some("sample-dashboard")
        );
        assert_eq!(
            project_label("C:\\PRIVATE_PATH\\sample-dashboard\\").as_deref(),
            Some("sample-dashboard")
        );
        assert!(project_label("/").is_none());
        assert!(project_label("/tmp/sk-proj-example").is_none());
    }

    #[test]
    fn optional_title_index_is_bounded_and_ignores_incomplete_or_invalid_records() {
        let root = tempfile::tempdir().unwrap();
        let path = create_session(root.path(), "session", None);
        append(&path, completed("call", "CommandExecution"));
        let index = root.path().join("session_index.jsonl");
        let mut file = File::create(&index).unwrap();
        file.write_all(&vec![b'x'; MAX_READ_BYTES as usize + 100])
            .unwrap();
        writeln!(file, "\ninvalid").unwrap();
        writeln!(
            file,
            "{}",
            json!({"id":"session","thread_name":"有界读取名称"})
        )
        .unwrap();
        write!(file, "{{\"id\":\"session\",\"thread_name\":\"未写完").unwrap();
        let mut cache = MonitorCache::default();
        assert_eq!(
            cache.snapshot(root.path(), NOW).sessions[0]
                .title
                .as_deref(),
            Some("有界读取名称")
        );
        writeln!(file, "\"}}").unwrap();
        assert_eq!(
            cache.snapshot(root.path(), NOW).sessions[0]
                .title
                .as_deref(),
            Some("未写完")
        );

        let other = tempfile::tempdir().unwrap();
        let path = create_session(other.path(), "session", None);
        append(&path, completed("call", "CommandExecution"));
        assert!(cache.snapshot(other.path(), NOW).sessions[0]
            .title
            .is_none());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&index, other.path().join("session_index.jsonl")).unwrap();
            assert!(cache.snapshot(other.path(), NOW).sessions[0]
                .title
                .is_none());
        }
    }

    #[test]
    fn extracts_execution_metadata_without_serializing_private_fields() {
        let root = tempfile::tempdir().unwrap();
        let path = create_session(root.path(), "parent", None);
        let mut event = completed("call-private-id", "CommandExecution");
        event["payload"]["item"]["command"] = json!("PRIVATE_COMMAND --token PRIVATE_TOKEN");
        event["payload"]["item"]["aggregated_output"] = json!("PRIVATE_OUTPUT");
        event["payload"]["item"]["exit_code"] = json!(7);
        event["payload"]["item"]["duration"] = json!({"secs":0,"nanos":50_000_000});
        append(&path, event);
        let child = create_session(root.path(), "child", Some("parent"));
        let mut event = completed("mcp", "McpToolCall");
        event["payload"]["item"]["server"] = json!("PRIVATE_TOKEN");
        event["payload"]["item"]["tool"] = json!("PRIVATE_EMAIL");
        event["payload"]["item"]["result"] =
            json!({"isError":true,"content":[{"text":"PRIVATE_OUTPUT"}]});
        append(&child, event);
        let snapshot = MonitorCache::default().snapshot(root.path(), NOW);
        assert_eq!(snapshot.calls.len(), 2);
        assert!(snapshot
            .calls
            .iter()
            .all(|call| call.status == CallStatus::Failed));
        assert_eq!(
            snapshot
                .calls
                .iter()
                .find(|call| call.kind == ToolKind::Command)
                .unwrap()
                .duration_ms,
            Some(50)
        );
        assert!(snapshot
            .sessions
            .iter()
            .any(|session| session.parent_id == Some(identifier("session", "parent"))));
        let serialized = serde_json::to_string(&snapshot).unwrap();
        assert!(!serialized.contains("PRIVATE_"));
        assert!(!serialized.contains("call-private-id"));
        assert!(!serialized.contains("turn-a"));
    }

    #[test]
    fn appends_complete_lines_and_deduplicates_without_counting_outer_wrappers() {
        let root = tempfile::tempdir().unwrap();
        let path = create_session(root.path(), "session", None);
        append(
            &path,
            json!({"type":"response_item","timestamp":NOW,"payload":{"type":"custom_tool_call","name":"exec","call_id":"outer","status":"completed"}}),
        );
        let mut cache = MonitorCache::default();
        let first = cache.snapshot(root.path(), NOW);
        assert_eq!(first.calls[0].status, CallStatus::Pending);
        assert_eq!(first.calls[0].source, CallSource::CallRecord);
        let event = completed("inner", "FileChange").to_string();
        let half = event.len() / 2;
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(event[..half].as_bytes()).unwrap();
        stamp(&file);
        assert_eq!(
            cache.snapshot(root.path(), NOW).calls[0].source,
            CallSource::CallRecord
        );
        writeln!(file, "{}", &event[half..]).unwrap();
        append(&path, completed("inner", "FileChange"));
        for _ in 0..2 {
            let snapshot = cache.snapshot(root.path(), NOW);
            assert_eq!(snapshot.calls.len(), 1);
            assert_eq!(snapshot.calls[0].source, CallSource::ExecutionEvent);
            assert_eq!(snapshot.calls[0].duration_ms, Some(1200));
        }
    }

    #[test]
    fn legacy_returns_do_not_guess_failure_or_execution_duration_from_output_text() {
        let root = tempfile::tempdir().unwrap();
        let path = create_session(root.path(), "legacy", None);
        append(
            &path,
            json!({"type":"turn_context","timestamp":NOW-20,"payload":{"turn_id":"legacy-turn"}}),
        );
        append(
            &path,
            json!({"type":"response_item","timestamp":NOW-10,"payload":{"type":"function_call","name":"shell","call_id":"old"}}),
        );
        append(
            &path,
            json!({"type":"response_item","timestamp":NOW,"payload":{"type":"function_call_output","call_id":"old","output":"error PRIVATE_TOKEN"}}),
        );
        let snapshot = MonitorCache::default().snapshot(root.path(), NOW);
        let call = &snapshot.calls[0];
        assert_eq!(call.status, CallStatus::Completed);
        assert_eq!(call.duration_ms, None);
        assert_eq!(call.turn_id, Some(identifier("turn", "legacy-turn")));
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("PRIVATE_TOKEN"));
    }

    #[test]
    fn completed_item_wins_over_late_start_and_unknown_status_stays_unknown() {
        let root = tempfile::tempdir().unwrap();
        let path = create_session(root.path(), "session", None);
        append(&path, completed("a", "CommandExecution"));
        let mut start = completed("a", "CommandExecution");
        start["payload"]["type"] = json!("item_started");
        append(&path, start);
        let mut unknown = completed("b", "McpToolCall");
        unknown["payload"]["item"]["status"] = json!("new_unrecognized_status");
        append(&path, unknown);
        let snapshot = MonitorCache::default().snapshot(root.path(), NOW);
        assert_eq!(snapshot.calls.len(), 2);
        assert!(snapshot
            .calls
            .iter()
            .any(|call| call.status == CallStatus::Completed));
        assert!(snapshot
            .calls
            .iter()
            .any(|call| call.status == CallStatus::Unknown));
    }

    #[test]
    fn truncation_replacement_and_archiving_do_not_duplicate_or_retain_stale_calls() {
        let root = tempfile::tempdir().unwrap();
        let path = create_session(root.path(), "session", None);
        append(&path, completed("old", "CommandExecution"));
        let mut cache = MonitorCache::default();
        assert_eq!(cache.snapshot(root.path(), NOW).calls.len(), 1);
        fs::write(&path, "").unwrap();
        append(&path, completed("new", "FileChange"));
        assert_eq!(
            cache.snapshot(root.path(), NOW).calls[0].kind,
            ToolKind::FileChange
        );
        let archive = root.path().join("archived_sessions");
        fs::create_dir(&archive).unwrap();
        fs::rename(path, archive.join("moved.jsonl")).unwrap();
        assert_eq!(cache.snapshot(root.path(), NOW).calls.len(), 1);
        assert!(cache
            .snapshot(root.path(), NOW + WINDOW_MS + 1)
            .calls
            .is_empty());
    }

    #[test]
    fn malformed_and_oversized_records_are_bounded_and_reported() {
        let root = tempfile::tempdir().unwrap();
        let path = create_session(root.path(), "session", None);
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "invalid json").unwrap();
        writeln!(file, "{}", "x".repeat(MAX_LINE_BYTES + 1)).unwrap();
        append(&path, completed("valid", "FileChange"));
        let snapshot = MonitorCache::default().snapshot(root.path(), NOW);
        assert_eq!(snapshot.skipped_lines, 2);
        assert_eq!(snapshot.calls.len(), 1);
    }

    #[test]
    fn missing_directories_are_empty_but_unreadable_sources_are_reported() {
        let root = tempfile::tempdir().unwrap();
        let mut cache = MonitorCache::default();
        assert_eq!(cache.snapshot(root.path(), NOW).unreadable_files, 0);
        fs::write(root.path().join("sessions"), "not a directory").unwrap();
        assert_eq!(cache.snapshot(root.path(), NOW).unreadable_files, 1);
    }

    #[cfg(unix)]
    #[test]
    fn session_symlinks_are_not_followed() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let path = create_session(other.path(), "outside", None);
        append(&path, completed("private", "CommandExecution"));
        fs::create_dir(root.path().join("sessions")).unwrap();
        std::os::unix::fs::symlink(path, root.path().join("sessions/link.jsonl")).unwrap();
        assert!(MonitorCache::default()
            .snapshot(root.path(), NOW)
            .calls
            .is_empty());
    }

    #[test]
    fn execution_events_win_across_duplicate_active_and_archived_files() {
        let root = tempfile::tempdir().unwrap();
        let path = create_session(root.path(), "session", None);
        append(
            &path,
            json!({"type":"response_item","timestamp":NOW,"payload":{"type":"function_call","name":"exec","call_id":"outer"}}),
        );
        let archived = root.path().join("archived_sessions");
        fs::create_dir(&archived).unwrap();
        let copy = archived.join("copy.jsonl");
        fs::copy(&path, &copy).unwrap();
        append(&copy, completed("inner", "CommandExecution"));
        let snapshot = MonitorCache::default().snapshot(root.path(), NOW);
        assert_eq!(snapshot.calls.len(), 1);
        assert_eq!(snapshot.calls[0].source, CallSource::ExecutionEvent);
        assert_eq!(snapshot.sessions.len(), 1);
    }

    #[test]
    fn repeated_item_ids_in_different_turns_and_cancelled_processes_remain_distinct() {
        let root = tempfile::tempdir().unwrap();
        let path = create_session(root.path(), "session", None);
        append(&path, completed("same-id", "CommandExecution"));
        let mut event = completed("same-id", "CommandExecution");
        event["payload"]["turn_id"] = json!("turn-b");
        event["payload"]["item"]["status"] = json!("cancelled");
        event["payload"]["item"]["exit_code"] = json!(-1);
        append(&path, event);
        let snapshot = MonitorCache::default().snapshot(root.path(), NOW);
        assert_eq!(snapshot.calls.len(), 2);
        assert!(snapshot
            .calls
            .iter()
            .any(|call| call.status == CallStatus::Cancelled));
        assert!(!snapshot
            .calls
            .iter()
            .any(|call| call.status == CallStatus::Failed));
    }

    #[test]
    fn per_file_retention_limits_are_disclosed_and_keep_recent_calls() {
        let root = tempfile::tempdir().unwrap();
        let path = create_session(root.path(), "session", None);
        for index in 0..MAX_FILE_CALLS + 2 {
            let mut event = completed(&format!("call-{index}"), "FileChange");
            event["payload"]["completed_at_ms"] = json!(NOW - 1000 + index as u64);
            append(&path, event);
        }
        let snapshot = MonitorCache::default().snapshot(root.path(), NOW);
        assert_eq!(snapshot.calls.len(), MAX_FILE_CALLS);
        assert!(snapshot.limited);
        assert!(snapshot
            .calls
            .iter()
            .all(|call| call.observed_at_ms >= NOW - 998));
    }
}
