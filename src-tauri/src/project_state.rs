//! Codex 26.1103 桌面项目状态的本地兼容层，不是公开稳定接口。
//! 仅向目标账号合并已知形态的纯本地项目入口；不迁移云端绑定、会话、权限或认证。
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};

const STATE_FILE: &str = ".codex-global-state.json";
const SCOPED_KEY: &str = "electron-account-renderer-state-v1";
const PROJECTS_KEY: &str = "local-projects";
const ORDER_KEY: &str = "project-order";
const MAX_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const INSPECT_ERROR: &str = "无法安全读取 Codex 项目配置；可关闭沿用本地项目后切换账号";
pub(crate) const IDENTITY_ERROR: &str =
    "无法确认项目所属账号；请重新登录，或关闭沿用本地项目后切换账号";
pub(crate) const QUIT_REQUIRED: &str =
    "沿用本地项目需要先完全退出 Codex，或选择切换并重启；也可关闭沿用后仅切换账号";
pub(crate) const UNSUPPORTED: &str = "当前环境无法安全沿用本地项目；请关闭沿用本地项目后切换账号";

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CarryOutcome {
    Disabled,
    NotNeeded,
    Copied,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CarryResult {
    pub outcome: CarryOutcome,
    pub copied: usize,
    pub skipped: usize,
}

impl CarryResult {
    pub fn disabled() -> Self {
        Self {
            outcome: CarryOutcome::Disabled,
            copied: 0,
            skipped: 0,
        }
    }
}

// 不派生 Debug/Serialize：快照可能含有其它客户端的私密状态，只在后端内存中处理。
pub(crate) struct PreparedCopy {
    before: Vec<u8>,
    after: Option<Vec<u8>>,
    pub result: CarryResult,
}

impl PreparedCopy {
    fn unchanged(skipped: usize) -> Self {
        Self {
            before: Vec::new(),
            after: None,
            result: CarryResult {
                outcome: CarryOutcome::NotNeeded,
                copied: 0,
                skipped,
            },
        }
    }

    pub fn needs_write(&self) -> bool {
        self.after.is_some()
    }

    /// 调用方须在写入前确认桌面客户端已停止，并在此操作结束后才启动客户端。
    /// 备份失败或快照变化时不覆盖状态；错误只返回固定结果，不输出文件内容。
    pub fn apply(self, codex_home: &Path, backup: &Path) -> CarryResult {
        let Some(after) = self.after else {
            return self.result;
        };
        let path = codex_home.join(STATE_FILE);
        let write = || -> Result<(), ()> {
            if read_state(&path)?.as_deref() != Some(self.before.as_slice()) {
                return Err(());
            }
            reject_symlink(backup)?;
            crate::storage::atomic_write(backup, &self.before).map_err(|_| ())?;
            if read_state(&path)?.as_deref() != Some(self.before.as_slice()) {
                return Err(());
            }
            crate::storage::atomic_write(&path, &after).map_err(|_| ())
        };
        if write().is_ok() {
            self.result
        } else {
            CarryResult {
                outcome: CarryOutcome::Failed,
                copied: 0,
                skipped: self.result.skipped,
            }
        }
    }
}

fn reject_symlink(path: &Path) -> Result<(), ()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(()),
    }
}

fn read_state(path: &Path) -> Result<Option<Vec<u8>>, ()> {
    reject_symlink(path)?;
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    if file.metadata().map_err(|_| ())?.len() > MAX_BYTES {
        return Err(());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(());
    }
    Ok(Some(bytes))
}

// 与已核验桌面版 sha256(JSON.stringify([userId, accountId])) 保持一致。
fn owner_key(auth: &Value) -> Option<String> {
    let identity = crate::manager::validate_chatgpt_auth(auth).ok()?;
    let tokens = auth.get("tokens")?;
    let mut users = Vec::new();
    for name in ["id_token", "access_token"] {
        let Some(token) = tokens.get(name).and_then(Value::as_str) else {
            continue;
        };
        let Some(payload) = token.split('.').nth(1) else {
            continue;
        };
        let Some(claims) = URL_SAFE_NO_PAD
            .decode(payload)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        else {
            continue;
        };
        if let Some(user) = claims
            .pointer("/https:~1~1api.openai.com~1auth/chatgpt_user_id")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        {
            users.push(user.to_owned());
        }
    }
    let user = users.first()?;
    if users.iter().any(|other| other != user) {
        return None;
    }
    let encoded = serde_json::to_vec(&[user.as_str(), identity.account_id.as_str()]).ok()?;
    Some(format!("{:x}", Sha256::digest(encoded)))
}

fn valid_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub(crate) fn prepare(
    codex_home: &Path,
    source_auth: &Value,
    target_auth: &Value,
) -> Result<PreparedCopy, &'static str> {
    let Some(before) = read_state(&codex_home.join(STATE_FILE)).map_err(|_| INSPECT_ERROR)? else {
        return Ok(PreparedCopy::unchanged(0));
    };
    let mut state: Value = serde_json::from_slice(&before).map_err(|_| INSPECT_ERROR)?;
    let object = state.as_object().ok_or(INSPECT_ERROR)?;
    let Some(scoped) = object.get(SCOPED_KEY) else {
        return Ok(PreparedCopy::unchanged(0));
    };
    let scoped = scoped.as_object().ok_or(INSPECT_ERROR)?;
    let owner = match scoped.get("owner") {
        Some(Value::Null) => None,
        Some(Value::String(key)) if valid_key(key) => Some(key.as_str()),
        _ => return Err(INSPECT_ERROR),
    };
    let inactive = scoped
        .get("inactive")
        .and_then(Value::as_object)
        .ok_or(INSPECT_ERROR)?;
    // 未识别的版本、重复的当前账号槽位都不猜测。
    if inactive.keys().any(|key| !valid_key(key))
        || owner.is_some_and(|key| inactive.contains_key(key))
    {
        return Err(INSPECT_ERROR);
    }
    let source_key = owner_key(source_auth).ok_or(IDENTITY_ERROR)?;
    let target_key = owner_key(target_auth).ok_or(IDENTITY_ERROR)?;
    if source_key == target_key {
        return Ok(PreparedCopy::unchanged(0));
    }
    let source = if owner == Some(source_key.as_str()) {
        object
    } else {
        inactive
            .get(&source_key)
            .and_then(|v| v.get("globals"))
            .and_then(Value::as_object)
            .ok_or(IDENTITY_ERROR)?
    };
    let target_active = owner == Some(target_key.as_str());
    let mut target_snapshot = if target_active {
        Value::Null
    } else {
        inactive
            .get(&target_key)
            .cloned()
            .unwrap_or_else(|| json!({"atoms": {}, "globals": {}}))
    };
    let target = if target_active {
        object.clone()
    } else {
        if !target_snapshot.get("atoms").is_some_and(Value::is_object) {
            return Err(INSPECT_ERROR);
        }
        target_snapshot
            .get("globals")
            .and_then(Value::as_object)
            .ok_or(INSPECT_ERROR)?
            .clone()
    };
    let (merged, copied, skipped) = merge_projects(source, target)?;
    if copied == 0 {
        return Ok(PreparedCopy::unchanged(skipped));
    }
    if target_active {
        let root = state.as_object_mut().ok_or(INSPECT_ERROR)?;
        for key in [PROJECTS_KEY, ORDER_KEY] {
            if let Some(value) = merged.get(key) {
                root.insert(key.to_owned(), value.clone());
            }
        }
    } else {
        target_snapshot["globals"] = Value::Object(merged);
        state[SCOPED_KEY]["inactive"][&target_key] = target_snapshot;
    }
    let after = serde_json::to_vec(&state).map_err(|_| INSPECT_ERROR)?;
    if after.len() as u64 > MAX_BYTES {
        return Err(INSPECT_ERROR);
    }
    Ok(PreparedCopy {
        before,
        after: Some(after),
        result: CarryResult {
            outcome: CarryOutcome::Copied,
            copied,
            skipped,
        },
    })
}

fn project_roots(project: &Value) -> Option<Vec<&str>> {
    let roots = project.get("rootPaths")?.as_array()?;
    if roots.is_empty() || roots.len() > 64 {
        return None;
    }
    roots
        .iter()
        .map(|r| r.as_str().filter(|r| Path::new(r).is_absolute()))
        .collect()
}

fn local_project(id: &str, project: &Value) -> bool {
    let Some(p) = project.as_object() else {
        return false;
    };
    !id.is_empty()
        && !id.starts_with("g-p-")
        && p.get("id").and_then(Value::as_str) == Some(id)
        && p.get("name")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
        && project_roots(project).is_some()
        && p.get("createdAt").is_some_and(Value::is_u64)
        && p.get("updatedAt").is_some_and(Value::is_u64)
        && p.keys().all(|key| {
            matches!(
                key.as_str(),
                "id" | "name" | "rootPaths" | "createdAt" | "updatedAt"
            )
        })
}

fn project_map(globals: &Map<String, Value>) -> Result<Map<String, Value>, &'static str> {
    match globals.get(PROJECTS_KEY) {
        None => Ok(Map::new()),
        Some(Value::Object(map)) => Ok(map.clone()),
        _ => Err(INSPECT_ERROR),
    }
}

fn order(globals: &Map<String, Value>) -> Result<Vec<String>, &'static str> {
    match globals.get(ORDER_KEY) {
        None => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned).ok_or(INSPECT_ERROR))
            .collect(),
        _ => Err(INSPECT_ERROR),
    }
}

fn merge_projects(
    source: &Map<String, Value>,
    mut target: Map<String, Value>,
) -> Result<(Map<String, Value>, usize, usize), &'static str> {
    let source_projects = project_map(source)?;
    let mut target_projects = project_map(&target)?;
    let mut source_order = order(source)?;
    for id in source_projects.keys() {
        if !source_order.contains(id) {
            source_order.push(id.clone());
        }
    }
    let mut target_order = order(&target)?;
    // 已有项目优先，缺少排序记录时也保持在新增项目之前。
    for id in target_projects.keys() {
        if !target_order.contains(id) {
            target_order.push(id.clone());
        }
    }
    let mut copied = 0;
    let mut skipped = 0;
    let mut seen = std::collections::HashSet::new();
    for id in source_order {
        if !seen.insert(id.clone()) {
            continue;
        }
        let Some(project) = source_projects.get(&id) else {
            continue;
        };
        if !local_project(&id, project) {
            skipped += 1;
            continue;
        }
        if let Some(existing) = target_projects.get(&id) {
            if project_roots(existing) != project_roots(project) {
                skipped += 1;
            }
            continue;
        }
        let mut roots = project_roots(project).ok_or(INSPECT_ERROR)?;
        roots.sort_unstable();
        if target_projects.values().any(|other| {
            project_roots(other).is_some_and(|mut existing| {
                existing.sort_unstable();
                existing == roots
            })
        }) {
            continue;
        }
        target_projects.insert(id.clone(), project.clone());
        if !target_order.contains(&id) {
            target_order.push(id);
        }
        copied += 1;
    }
    if copied > 0 {
        target.insert(PROJECTS_KEY.to_owned(), Value::Object(target_projects));
        target.insert(ORDER_KEY.to_owned(), json!(target_order));
    }
    Ok((target, copied, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth(account: &str) -> Value {
        let claims = json!({"https://api.openai.com/auth": {
            "chatgpt_user_id": format!("user-{account}"), "chatgpt_account_id": account
        }});
        let token = format!(
            "e30.{}.synthetic",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
        );
        json!({"auth_mode":"chatgpt","tokens":{
            "id_token":token,"access_token":"synthetic-access","refresh_token":"synthetic-refresh","account_id":account
        }})
    }

    fn project(id: &str) -> Value {
        json!({"id":id,"name":id,"rootPaths":[std::env::temp_dir().join(id)],"createdAt":1,"updatedAt":2})
    }

    fn state() -> Value {
        let source = owner_key(&auth("source")).unwrap();
        let target = owner_key(&auth("target")).unwrap();
        json!({
            SCOPED_KEY:{"owner":source,"inactive":{
                target:{"atoms":{"unrelated":"target-secret"},"globals":{
                    PROJECTS_KEY:{"existing":project("existing")},ORDER_KEY:["existing"],
                    "selected-project":{"projectId":"existing","type":"local"},
                    "thread-project-assignments":{"target-thread":{"projectId":"existing"}}
                }}
            }},
            PROJECTS_KEY:{"one":project("one"),"two":project("two")},ORDER_KEY:["two","one"],
            "electron-persisted-atom-state":{"private":"source-secret"},
            "thread-project-assignments":{"source-thread":{"projectId":"one"}},
            "future-field":{"preserve":true}
        })
    }

    fn fixture(value: &Value) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(STATE_FILE),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap();
        dir
    }

    fn read(dir: &Path) -> Value {
        serde_json::from_slice(&fs::read(dir.join(STATE_FILE)).unwrap()).unwrap()
    }

    #[test]
    fn owner_key_matches_desktop_array_json_sha256_and_rejects_conflicting_users() {
        assert_eq!(
            owner_key(&auth("source")).as_deref(),
            Some("ce37dc9a46d98c08c5a6674279ae1cd314998c037f9a00cd8579da462afddc29")
        );
        let mut conflicting = auth("source");
        let claims = json!({"https://api.openai.com/auth": {
            "chatgpt_user_id": "other-user", "chatgpt_account_id": "source"
        }});
        conflicting["tokens"]["access_token"] = json!(format!(
            "e30.{}.synthetic",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
        ));
        assert!(owner_key(&conflicting).is_none());
    }

    #[test]
    fn copy_merges_target_and_preserves_source_private_state_and_other_fields() {
        let before = state();
        let dir = fixture(&before);
        let target = owner_key(&auth("target")).unwrap();
        let copy = prepare(dir.path(), &auth("source"), &auth("target")).unwrap();
        let backup = dir.path().join("backup.json");
        let result = copy.apply(dir.path(), &backup);
        assert_eq!(
            result,
            CarryResult {
                outcome: CarryOutcome::Copied,
                copied: 2,
                skipped: 0
            }
        );
        let mut expected = before.clone();
        expected[SCOPED_KEY]["inactive"][&target]["globals"][PROJECTS_KEY]["one"] = project("one");
        expected[SCOPED_KEY]["inactive"][&target]["globals"][PROJECTS_KEY]["two"] = project("two");
        expected[SCOPED_KEY]["inactive"][&target]["globals"][ORDER_KEY] =
            json!(["existing", "two", "one"]);
        assert_eq!(read(dir.path()), expected);
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(backup).unwrap()).unwrap(),
            before
        );
        let result_json = serde_json::to_string(&result).unwrap();
        assert!(!result_json.contains("secret"));
        assert!(!result_json.contains(&target));
        assert!(!prepare(dir.path(), &auth("source"), &auth("target"))
            .unwrap()
            .needs_write());
    }

    #[test]
    fn target_may_be_new_and_source_may_be_inactive_after_quit() {
        let mut value = state();
        let source = owner_key(&auth("source")).unwrap();
        value[SCOPED_KEY] = json!({"owner":null,"inactive":{
            source.clone():{"atoms":{},"globals":{PROJECTS_KEY:{"one":project("one")}}}
        }});
        value.as_object_mut().unwrap().remove(PROJECTS_KEY);
        let dir = fixture(&value);
        let result = prepare(dir.path(), &auth("source"), &auth("target"))
            .unwrap()
            .apply(dir.path(), &dir.path().join("backup"));
        assert_eq!(result.copied, 1);
        let after = read(dir.path());
        let target = owner_key(&auth("target")).unwrap();
        assert_eq!(after[SCOPED_KEY]["owner"], Value::Null);
        assert_eq!(
            after[SCOPED_KEY]["inactive"][&source],
            value[SCOPED_KEY]["inactive"][&source]
        );
        assert_eq!(after[SCOPED_KEY]["inactive"][target]["atoms"], json!({}));
    }

    #[test]
    fn active_target_is_supported_without_changing_its_owner() {
        let mut value = state();
        let source = owner_key(&auth("source")).unwrap();
        let target = owner_key(&auth("target")).unwrap();
        value[SCOPED_KEY] = json!({"owner":target,"inactive":{source:{"atoms":{},"globals":{PROJECTS_KEY:{"new":project("new")}}}}});
        let dir = fixture(&value);
        let result = prepare(dir.path(), &auth("source"), &auth("target"))
            .unwrap()
            .apply(dir.path(), &dir.path().join("backup"));
        assert_eq!(result.copied, 1);
        assert_eq!(read(dir.path())[PROJECTS_KEY]["new"], project("new"));
        assert_eq!(read(dir.path())[SCOPED_KEY], value[SCOPED_KEY]);
    }

    #[test]
    fn cloud_unknown_relative_paths_and_conflicts_are_not_migrated() {
        let mut value = state();
        let target = owner_key(&auth("target")).unwrap();
        value[PROJECTS_KEY]["cloud"] = project("cloud");
        value[PROJECTS_KEY]["cloud"]["chatGptBacking"] = json!({"accountId":"another-account"});
        value[PROJECTS_KEY]["g-p-cloud"] = project("g-p-cloud");
        value[PROJECTS_KEY]["future"] = project("future");
        value[PROJECTS_KEY]["future"]["newOwnershipField"] = json!(true);
        value[PROJECTS_KEY]["relative"] = project("relative");
        value[PROJECTS_KEY]["relative"]["rootPaths"] = json!(["relative/path"]);
        value[PROJECTS_KEY]["existing"] = project("existing");
        value[PROJECTS_KEY]["existing"]["rootPaths"] =
            json!([std::env::temp_dir().join("different")]);
        value[PROJECTS_KEY]["duplicate"] = project("duplicate");
        value[PROJECTS_KEY]["duplicate"]["rootPaths"] = project("existing")["rootPaths"].clone();
        let dir = fixture(&value);
        let result = prepare(dir.path(), &auth("source"), &auth("target"))
            .unwrap()
            .apply(dir.path(), &dir.path().join("backup"));
        assert_eq!(result.copied, 2);
        assert_eq!(result.skipped, 5);
        assert_eq!(
            read(dir.path())[SCOPED_KEY]["inactive"][&target]["globals"][PROJECTS_KEY]
                .as_object()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            read(dir.path())[SCOPED_KEY]["inactive"][target]["globals"][PROJECTS_KEY]["existing"],
            project("existing")
        );
    }

    #[test]
    fn legacy_missing_and_same_account_states_are_noops() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!prepare(dir.path(), &Value::Null, &Value::Null)
            .unwrap()
            .needs_write());
        fs::write(dir.path().join(STATE_FILE), b"{\"local-projects\":{}}").unwrap();
        assert!(!prepare(dir.path(), &Value::Null, &Value::Null)
            .unwrap()
            .needs_write());
        let dir = fixture(&state());
        assert!(!prepare(dir.path(), &auth("source"), &auth("source"))
            .unwrap()
            .needs_write());
    }

    #[test]
    fn malformed_and_missing_identity_never_guess_another_account() {
        let dir = fixture(&state());
        assert_eq!(
            prepare(dir.path(), &auth("absent"), &auth("target")).err(),
            Some(IDENTITY_ERROR)
        );
        assert_eq!(
            prepare(dir.path(), &Value::Null, &auth("target")).err(),
            Some(IDENTITY_ERROR)
        );
        for scoped in [
            json!({"owner":"invalid","inactive":{}}),
            json!({"owner":null}),
            json!([]),
        ] {
            let mut value = state();
            value[SCOPED_KEY] = scoped;
            let dir = fixture(&value);
            assert_eq!(
                prepare(dir.path(), &auth("source"), &auth("target")).err(),
                Some(INSPECT_ERROR)
            );
        }
        fs::write(dir.path().join(STATE_FILE), b"{private-secret:broken}").unwrap();
        assert_eq!(
            prepare(dir.path(), &auth("source"), &auth("target")).err(),
            Some(INSPECT_ERROR)
        );
    }

    #[test]
    fn changed_file_and_backup_failure_do_not_overwrite_state() {
        let value = state();
        let dir = fixture(&value);
        let copy = prepare(dir.path(), &auth("source"), &auth("target")).unwrap();
        let mut changed = value.clone();
        changed["new-write"] = json!(true);
        fs::write(
            dir.path().join(STATE_FILE),
            serde_json::to_vec(&changed).unwrap(),
        )
        .unwrap();
        assert_eq!(
            copy.apply(dir.path(), &dir.path().join("backup")).outcome,
            CarryOutcome::Failed
        );
        assert_eq!(read(dir.path()), changed);
        assert!(!dir.path().join("backup").exists());
        let copy = prepare(dir.path(), &auth("source"), &auth("target")).unwrap();
        fs::create_dir(dir.path().join("backup")).unwrap();
        assert_eq!(
            copy.apply(dir.path(), &dir.path().join("backup")).outcome,
            CarryOutcome::Failed
        );
        assert_eq!(read(dir.path()), changed);
    }

    #[test]
    fn oversized_state_is_rejected_before_reading_contents() {
        let dir = tempfile::tempdir().unwrap();
        let f = fs::File::create(dir.path().join(STATE_FILE)).unwrap();
        f.set_len(MAX_BYTES + 1).unwrap();
        assert_eq!(
            prepare(dir.path(), &auth("source"), &auth("target")).err(),
            Some(INSPECT_ERROR)
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed_and_backup_is_private() {
        use std::os::unix::{fs::symlink, fs::PermissionsExt};
        let value = state();
        let dir = fixture(&value);
        let other = fixture(&value);
        fs::remove_file(dir.path().join(STATE_FILE)).unwrap();
        symlink(other.path().join(STATE_FILE), dir.path().join(STATE_FILE)).unwrap();
        assert!(prepare(dir.path(), &auth("source"), &auth("target")).is_err());
        let dir = fixture(&value);
        let backup = dir.path().join("backup");
        symlink(other.path().join(STATE_FILE), &backup).unwrap();
        let copy = prepare(dir.path(), &auth("source"), &auth("target")).unwrap();
        assert_eq!(
            copy.apply(dir.path(), &backup).outcome,
            CarryOutcome::Failed
        );
        assert_eq!(read(other.path()), value);
        fs::remove_file(&backup).unwrap();
        prepare(dir.path(), &auth("source"), &auth("target"))
            .unwrap()
            .apply(dir.path(), &backup);
        assert_eq!(
            fs::metadata(backup).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
