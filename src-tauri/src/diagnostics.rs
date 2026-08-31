use crate::manager::validate_chatgpt_auth;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const SUPPORTED_VAULT_VERSION: u32 = 1;
const MAX_DIAGNOSTIC_FILE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticLevel {
    Pass,
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticCheck {
    pub id: &'static str,
    pub outcome: &'static str,
    pub level: DiagnosticLevel,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDiagnostics {
    pub health: &'static str,
    pub pass_count: u32,
    pub info_count: u32,
    pub warning_count: u32,
    pub error_count: u32,
    pub generated_at: u64,
    pub checks: Vec<DiagnosticCheck>,
}

#[derive(Debug, Deserialize)]
struct DiagnosticVault {
    version: u32,
    profiles: Vec<DiagnosticProfile>,
    #[serde(default)]
    activations: Vec<DiagnosticActivation>,
}

#[derive(Debug, Deserialize)]
struct DiagnosticProfile {
    id: String,
    label: String,
    account_id: String,
    auth: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticActivation {
    account_id: String,
    activated_at: u64,
}

struct LiveAuthInspection {
    check: DiagnosticCheck,
    account_id: Option<String>,
}

struct VaultInspection {
    vault_check: DiagnosticCheck,
    activation_check: DiagnosticCheck,
    account_ids: HashSet<String>,
}

impl DiagnosticCheck {
    fn new(id: &'static str, outcome: &'static str, level: DiagnosticLevel) -> Self {
        Self {
            id,
            outcome,
            level,
            count: None,
            value: None,
        }
    }

    fn with_count(mut self, count: usize) -> Self {
        self.count = u64::try_from(count).ok();
        self
    }

    fn with_value(mut self, value: impl Into<String>) -> Self {
        self.value = Some(value.into());
        self
    }
}

pub fn run_local_diagnostics(codex_home: &Path, vault_path: &Path) -> LocalDiagnostics {
    let auth_path = codex_home.join("auth.json");
    let mut checks = vec![inspect_codex_home(codex_home), inspect_config(codex_home)];

    let live_auth = inspect_live_auth(&auth_path);
    checks.push(live_auth.check);
    checks.push(inspect_permissions(codex_home, &auth_path, vault_path));

    let vault = inspect_vault(vault_path);
    checks.push(vault.vault_check);
    checks.push(vault.activation_check);
    checks.push(inspect_active_profile(
        live_auth.account_id.as_deref(),
        &vault.account_ids,
    ));
    checks.push(inspect_atomic_residue(codex_home, vault_path));

    finish_report(checks)
}

fn inspect_codex_home(path: &Path) -> DiagnosticCheck {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return DiagnosticCheck::new("codexHome", "missing", DiagnosticLevel::Error)
        }
        Err(_) => return DiagnosticCheck::new("codexHome", "unreadable", DiagnosticLevel::Error),
    };
    if !metadata.is_dir() {
        return DiagnosticCheck::new("codexHome", "notDirectory", DiagnosticLevel::Error);
    }
    match fs::read_dir(path) {
        Ok(_) => DiagnosticCheck::new("codexHome", "ready", DiagnosticLevel::Pass),
        Err(_) => DiagnosticCheck::new("codexHome", "unreadable", DiagnosticLevel::Error),
    }
}

fn inspect_config(codex_home: &Path) -> DiagnosticCheck {
    let path = codex_home.join("config.toml");
    if !path.exists() {
        return DiagnosticCheck::new("config", "default", DiagnosticLevel::Info);
    }
    let contents = match read_limited(&path) {
        Ok(contents) => contents,
        Err(_) => return DiagnosticCheck::new("config", "unreadable", DiagnosticLevel::Error),
    };
    let contents = match std::str::from_utf8(&contents) {
        Ok(contents) => contents,
        Err(_) => return DiagnosticCheck::new("config", "invalid", DiagnosticLevel::Error),
    };
    let config = match contents.parse::<toml::Table>() {
        Ok(config) => config,
        Err(_) => return DiagnosticCheck::new("config", "invalid", DiagnosticLevel::Error),
    };
    let storage_mode = config
        .get("cli_auth_credentials_store")
        .and_then(toml::Value::as_str)
        .unwrap_or("file")
        .to_ascii_lowercase();
    if storage_mode == "file" {
        DiagnosticCheck::new("config", "ready", DiagnosticLevel::Pass)
    } else {
        DiagnosticCheck::new("config", "unsupported", DiagnosticLevel::Warning)
    }
}

fn inspect_live_auth(path: &Path) -> LiveAuthInspection {
    if !path.exists() {
        return LiveAuthInspection {
            check: DiagnosticCheck::new("liveAuth", "missing", DiagnosticLevel::Info),
            account_id: None,
        };
    }
    let auth = match read_json_value(path) {
        Ok(auth) => auth,
        Err(_) => {
            return LiveAuthInspection {
                check: DiagnosticCheck::new("liveAuth", "invalid", DiagnosticLevel::Error),
                account_id: None,
            }
        }
    };
    if auth.get("auth_mode").and_then(Value::as_str) == Some("apikey") {
        return LiveAuthInspection {
            check: DiagnosticCheck::new("liveAuth", "apiKey", DiagnosticLevel::Info),
            account_id: None,
        };
    }
    match validate_chatgpt_auth(&auth) {
        Ok(identity) => LiveAuthInspection {
            check: DiagnosticCheck::new("liveAuth", "ready", DiagnosticLevel::Pass),
            account_id: Some(identity.account_id),
        },
        Err(_) => LiveAuthInspection {
            check: DiagnosticCheck::new("liveAuth", "invalid", DiagnosticLevel::Error),
            account_id: None,
        },
    }
}

fn inspect_vault(path: &Path) -> VaultInspection {
    if !path.exists() {
        return VaultInspection {
            vault_check: DiagnosticCheck::new("vault", "missing", DiagnosticLevel::Info),
            activation_check: DiagnosticCheck::new(
                "activationHistory",
                "notApplicable",
                DiagnosticLevel::Info,
            ),
            account_ids: HashSet::new(),
        };
    }
    let vault = match read_diagnostic_vault(path) {
        Ok(vault) => vault,
        Err(_) => {
            return VaultInspection {
                vault_check: DiagnosticCheck::new("vault", "invalid", DiagnosticLevel::Error),
                activation_check: DiagnosticCheck::new(
                    "activationHistory",
                    "unavailable",
                    DiagnosticLevel::Info,
                ),
                account_ids: HashSet::new(),
            }
        }
    };
    if vault.version != SUPPORTED_VAULT_VERSION {
        return VaultInspection {
            vault_check: DiagnosticCheck::new(
                "vault",
                "unsupportedVersion",
                DiagnosticLevel::Error,
            )
            .with_value(vault.version.to_string()),
            activation_check: DiagnosticCheck::new(
                "activationHistory",
                "unavailable",
                DiagnosticLevel::Info,
            ),
            account_ids: HashSet::new(),
        };
    }

    let mut profile_ids = HashSet::new();
    let mut account_ids = HashSet::new();
    let mut invalid_profiles = 0usize;
    for profile in &vault.profiles {
        let identity = validate_chatgpt_auth(&profile.auth).ok();
        let structurally_valid = !profile.id.trim().is_empty()
            && !profile.label.trim().is_empty()
            && !profile.account_id.trim().is_empty()
            && profile_ids.insert(profile.id.clone())
            && account_ids.insert(profile.account_id.clone());
        let identity_matches = identity
            .as_ref()
            .is_some_and(|identity| identity.account_id == profile.account_id);
        if !structurally_valid || !identity_matches {
            invalid_profiles = invalid_profiles.saturating_add(1);
        }
    }

    let vault_check = if invalid_profiles > 0 {
        DiagnosticCheck::new("vault", "inconsistent", DiagnosticLevel::Error)
            .with_count(invalid_profiles)
    } else if vault.profiles.is_empty() {
        DiagnosticCheck::new("vault", "empty", DiagnosticLevel::Info)
    } else {
        DiagnosticCheck::new("vault", "ready", DiagnosticLevel::Pass)
            .with_count(vault.profiles.len())
    };

    let activation_check = inspect_activations(&vault.activations, &account_ids);
    VaultInspection {
        vault_check,
        activation_check,
        account_ids,
    }
}

fn inspect_activations(
    activations: &[DiagnosticActivation],
    account_ids: &HashSet<String>,
) -> DiagnosticCheck {
    if activations.is_empty() {
        return DiagnosticCheck::new("activationHistory", "empty", DiagnosticLevel::Info);
    }
    let order_issues = activations
        .windows(2)
        .filter(|pair| pair[0].activated_at > pair[1].activated_at)
        .count();
    let reference_issues = activations
        .iter()
        .filter(|activation| !account_ids.contains(&activation.account_id))
        .count();
    let issues = order_issues.saturating_add(reference_issues);
    if issues > 0 {
        DiagnosticCheck::new(
            "activationHistory",
            "inconsistent",
            DiagnosticLevel::Warning,
        )
        .with_count(issues)
    } else {
        DiagnosticCheck::new("activationHistory", "ready", DiagnosticLevel::Pass)
            .with_count(activations.len())
    }
}

fn inspect_active_profile(
    active_account_id: Option<&str>,
    account_ids: &HashSet<String>,
) -> DiagnosticCheck {
    match active_account_id {
        Some(account_id) if account_ids.contains(account_id) => {
            DiagnosticCheck::new("activeProfile", "matched", DiagnosticLevel::Pass)
        }
        Some(_) => DiagnosticCheck::new("activeProfile", "unsaved", DiagnosticLevel::Info),
        None => DiagnosticCheck::new("activeProfile", "notApplicable", DiagnosticLevel::Info),
    }
}

#[cfg(unix)]
fn inspect_permissions(codex_home: &Path, auth_path: &Path, vault_path: &Path) -> DiagnosticCheck {
    use std::os::unix::fs::PermissionsExt;

    let mut paths = Vec::<PathBuf>::new();
    for path in [auth_path, vault_path] {
        if path.exists() {
            paths.push(path.to_path_buf());
            if let Some(parent) = path.parent() {
                paths.push(parent.to_path_buf());
            }
        }
    }
    if codex_home.exists() && auth_path.exists() {
        paths.push(codex_home.to_path_buf());
    }
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        return DiagnosticCheck::new(
            "credentialPermissions",
            "notApplicable",
            DiagnosticLevel::Info,
        );
    }

    let mut insecure = 0usize;
    for path in paths {
        match fs::symlink_metadata(&path) {
            Ok(metadata)
                if metadata.file_type().is_symlink()
                    || metadata.permissions().mode() & 0o077 != 0 =>
            {
                insecure = insecure.saturating_add(1);
            }
            Ok(_) => {}
            Err(_) => {
                return DiagnosticCheck::new(
                    "credentialPermissions",
                    "unavailable",
                    DiagnosticLevel::Warning,
                )
            }
        }
    }
    if insecure > 0 {
        DiagnosticCheck::new("credentialPermissions", "tooOpen", DiagnosticLevel::Warning)
            .with_count(insecure)
    } else {
        DiagnosticCheck::new("credentialPermissions", "ready", DiagnosticLevel::Pass)
    }
}

#[cfg(not(unix))]
fn inspect_permissions(
    _codex_home: &Path,
    _auth_path: &Path,
    _vault_path: &Path,
) -> DiagnosticCheck {
    DiagnosticCheck::new(
        "credentialPermissions",
        "platformManaged",
        DiagnosticLevel::Info,
    )
}

fn inspect_atomic_residue(codex_home: &Path, vault_path: &Path) -> DiagnosticCheck {
    let mut directories = vec![codex_home.to_path_buf()];
    if let Some(parent) = vault_path.parent() {
        directories.push(parent.to_path_buf());
    }
    directories.sort();
    directories.dedup();

    let mut residue = 0usize;
    for directory in directories {
        if !directory.exists() {
            continue;
        }
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(_) => {
                return DiagnosticCheck::new("atomicResidue", "unavailable", DiagnosticLevel::Info)
            }
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let temporary =
                name.starts_with('.') && name.contains(".cam-") && name.ends_with(".tmp");
            let backup = name.ends_with(".cam-backup");
            if temporary || backup {
                residue = residue.saturating_add(1);
            }
        }
    }
    if residue > 0 {
        DiagnosticCheck::new("atomicResidue", "found", DiagnosticLevel::Warning).with_count(residue)
    } else {
        DiagnosticCheck::new("atomicResidue", "clean", DiagnosticLevel::Pass)
    }
}

fn read_limited(path: &Path) -> Result<Vec<u8>, ()> {
    let metadata = fs::metadata(path).map_err(|_| ())?;
    if !metadata.is_file() || metadata.len() > MAX_DIAGNOSTIC_FILE_BYTES {
        return Err(());
    }
    fs::read(path).map_err(|_| ())
}

fn read_json_value(path: &Path) -> Result<Value, ()> {
    serde_json::from_slice(&read_limited(path)?).map_err(|_| ())
}

fn read_diagnostic_vault(path: &Path) -> Result<DiagnosticVault, ()> {
    serde_json::from_slice(&read_limited(path)?).map_err(|_| ())
}

fn finish_report(checks: Vec<DiagnosticCheck>) -> LocalDiagnostics {
    let count = |level| {
        u32::try_from(checks.iter().filter(|check| check.level == level).count())
            .unwrap_or(u32::MAX)
    };
    let pass_count = count(DiagnosticLevel::Pass);
    let info_count = count(DiagnosticLevel::Info);
    let warning_count = count(DiagnosticLevel::Warning);
    let error_count = count(DiagnosticLevel::Error);
    let health = if error_count > 0 {
        "error"
    } else if warning_count > 0 {
        "attention"
    } else {
        "healthy"
    };
    LocalDiagnostics {
        health,
        pass_count,
        info_count,
        warning_count,
        error_count,
        generated_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        checks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn auth(account_id: &str) -> Value {
        json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": {
                "access_token": "access-secret",
                "refresh_token": "refresh-secret",
                "account_id": account_id
            }
        })
    }

    fn write_json(path: &Path, value: &Value) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
        secure_test_path(path);
        if let Some(parent) = path.parent() {
            secure_test_path(parent);
        }
    }

    #[cfg(unix)]
    fn secure_test_path(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mode = if path.is_dir() { 0o700 } else { 0o600 };
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(not(unix))]
    fn secure_test_path(_path: &Path) {}

    fn check<'a>(report: &'a LocalDiagnostics, id: &str) -> &'a DiagnosticCheck {
        report.checks.iter().find(|check| check.id == id).unwrap()
    }

    #[test]
    fn reports_a_consistent_local_environment_as_healthy() {
        let codex = TempDir::new().unwrap();
        let app = TempDir::new().unwrap();
        secure_test_path(codex.path());
        secure_test_path(app.path());
        fs::write(
            codex.path().join("config.toml"),
            "cli_auth_credentials_store = \"file\"\n",
        )
        .unwrap();
        write_json(&codex.path().join("auth.json"), &auth("account-a"));
        let vault_path = app.path().join("accounts.v1.json");
        write_json(
            &vault_path,
            &json!({
                "version": 1,
                "profiles": [{
                    "id": "profile-a",
                    "label": "Personal",
                    "account_id": "account-a",
                    "auth": auth("account-a"),
                    "created_at": 1,
                    "updated_at": 1
                }],
                "activations": [{"accountId": "account-a", "activatedAt": 1}]
            }),
        );

        let report = run_local_diagnostics(codex.path(), &vault_path);

        assert_eq!(report.health, "healthy");
        assert_eq!(check(&report, "liveAuth").outcome, "ready");
        assert_eq!(check(&report, "vault").count, Some(1));
        assert_eq!(check(&report, "activeProfile").outcome, "matched");
        assert_eq!(check(&report, "atomicResidue").outcome, "clean");
    }

    #[test]
    fn reports_missing_files_without_exposing_secrets() {
        let codex = TempDir::new().unwrap();
        let app = TempDir::new().unwrap();
        secure_test_path(codex.path());
        secure_test_path(app.path());
        let report = run_local_diagnostics(codex.path(), &app.path().join("accounts.v1.json"));
        let serialized = serde_json::to_string(&report).unwrap();

        assert_eq!(check(&report, "liveAuth").outcome, "missing");
        assert_eq!(check(&report, "vault").outcome, "missing");
        assert!(!serialized.contains("token"));
        assert!(!serialized.contains(codex.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn detects_inconsistent_profiles_and_activation_history() {
        let codex = TempDir::new().unwrap();
        let app = TempDir::new().unwrap();
        secure_test_path(codex.path());
        secure_test_path(app.path());
        write_json(&codex.path().join("auth.json"), &auth("account-live"));
        let vault_path = app.path().join("accounts.v1.json");
        write_json(
            &vault_path,
            &json!({
                "version": 1,
                "profiles": [
                    {
                        "id": "duplicate",
                        "label": "One",
                        "account_id": "account-a",
                        "auth": auth("account-a")
                    },
                    {
                        "id": "duplicate",
                        "label": "Two",
                        "account_id": "account-b",
                        "auth": auth("wrong-account")
                    }
                ],
                "activations": [
                    {"accountId": "missing", "activatedAt": 20},
                    {"accountId": "account-a", "activatedAt": 10}
                ]
            }),
        );

        let report = run_local_diagnostics(codex.path(), &vault_path);

        assert_eq!(report.health, "error");
        assert_eq!(check(&report, "vault").outcome, "inconsistent");
        assert_eq!(check(&report, "vault").count, Some(1));
        assert_eq!(check(&report, "activationHistory").outcome, "inconsistent");
        assert_eq!(check(&report, "activationHistory").count, Some(2));
        assert_eq!(check(&report, "activeProfile").outcome, "unsaved");
    }

    #[test]
    fn detects_atomic_write_residue() {
        let codex = TempDir::new().unwrap();
        let app = TempDir::new().unwrap();
        secure_test_path(codex.path());
        secure_test_path(app.path());
        fs::write(codex.path().join(".auth.json.cam-1-2.tmp"), b"partial").unwrap();
        fs::write(app.path().join("accounts.v1.cam-backup"), b"backup").unwrap();

        let report = run_local_diagnostics(codex.path(), &app.path().join("accounts.v1.json"));

        assert_eq!(check(&report, "atomicResidue").outcome, "found");
        assert_eq!(check(&report, "atomicResidue").count, Some(2));
    }

    #[test]
    fn does_not_return_arbitrary_storage_mode_text() {
        let codex = TempDir::new().unwrap();
        let app = TempDir::new().unwrap();
        secure_test_path(codex.path());
        secure_test_path(app.path());
        fs::write(
            codex.path().join("config.toml"),
            "cli_auth_credentials_store = \"sensitive-user-text\"\n",
        )
        .unwrap();

        let report = run_local_diagnostics(codex.path(), &app.path().join("accounts.v1.json"));
        let config = check(&report, "config");
        let serialized = serde_json::to_string(&report).unwrap();

        assert_eq!(config.outcome, "unsupported");
        assert_eq!(config.value, None);
        assert!(!serialized.contains("sensitive-user-text"));
    }
}
