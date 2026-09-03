import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppStatus,
  AppUpdateCheckResult,
  AppUpdateSource,
  LocalDiagnosticCheck,
  LocalDiagnosticId,
  LocalDiagnostics,
  checkAppUpdate,
  getAppVersion,
  getLocalDiagnostics,
  installAppUpdate,
} from "./api";
import type { AppTab } from "./appTypes";
import { Locale, localizeBackendError, MessageKey, Translate } from "./i18n";
import { ThemeMode } from "./theme";

const UPDATE_SOURCE_STORAGE_KEY = "codex-auth-switch-update-source";

const storedUpdateSource = (): AppUpdateSource =>
  window.localStorage.getItem(UPDATE_SOURCE_STORAGE_KEY) === "cnb"
    ? "cnb"
    : "github";

type Option<T extends string> = {
  label: string;
  value: T;
};

type UpdateError = {
  phase: "check" | "install";
  message: string;
};

const diagnosticTitleKeys: Record<LocalDiagnosticId, MessageKey> = {
  codexHome: "diagnosticCodexHome",
  config: "diagnosticConfig",
  liveAuth: "diagnosticLiveAuth",
  credentialPermissions: "diagnosticCredentialPermissions",
  vault: "diagnosticVault",
  activationHistory: "diagnosticActivationHistory",
  activeProfile: "diagnosticActiveProfile",
  atomicResidue: "diagnosticAtomicResidue",
};

const diagnosticDetailKeys: Record<string, MessageKey> = {
  "codexHome:ready": "diagnosticReady",
  "codexHome:missing": "diagnosticMissingHome",
  "codexHome:notDirectory": "diagnosticNotDirectory",
  "codexHome:unreadable": "diagnosticUnreadable",
  "config:ready": "diagnosticReady",
  "config:default": "diagnosticDefaultConfig",
  "config:unreadable": "diagnosticUnreadable",
  "config:invalid": "diagnosticInvalidConfig",
  "config:unsupported": "diagnosticUnsupportedConfig",
  "liveAuth:ready": "diagnosticReady",
  "liveAuth:missing": "diagnosticMissingAuth",
  "liveAuth:apiKey": "diagnosticApiKeyAuth",
  "liveAuth:invalid": "diagnosticInvalidAuth",
  "credentialPermissions:ready": "diagnosticReady",
  "credentialPermissions:notApplicable": "diagnosticNotApplicable",
  "credentialPermissions:unavailable": "diagnosticPermissionUnavailable",
  "credentialPermissions:tooOpen": "diagnosticPermissionTooOpen",
  "credentialPermissions:platformManaged": "diagnosticPlatformPermissions",
  "vault:ready": "diagnosticReadyCount",
  "vault:missing": "diagnosticMissingVault",
  "vault:invalid": "diagnosticInvalidVault",
  "vault:unsupportedVersion": "diagnosticUnsupportedVault",
  "vault:inconsistent": "diagnosticInconsistentVault",
  "vault:empty": "diagnosticEmptyVault",
  "activationHistory:ready": "diagnosticReadyCount",
  "activationHistory:notApplicable": "diagnosticNotApplicable",
  "activationHistory:unavailable": "diagnosticUnavailable",
  "activationHistory:empty": "diagnosticEmptyHistory",
  "activationHistory:inconsistent": "diagnosticInconsistentHistory",
  "activeProfile:matched": "diagnosticActiveMatched",
  "activeProfile:unsaved": "diagnosticActiveUnsaved",
  "activeProfile:notApplicable": "diagnosticNotApplicable",
  "atomicResidue:clean": "diagnosticAtomicClean",
  "atomicResidue:found": "diagnosticAtomicFound",
  "atomicResidue:unavailable": "diagnosticUnavailable",
};

const diagnosticDetail = (check: LocalDiagnosticCheck, t: Translate) =>
  t(
    diagnosticDetailKeys[`${check.id}:${check.outcome}`] ?? "diagnosticUnknown",
    {
      count: check.count ?? 0,
      value: check.value ?? "—",
    },
  );

type SettingsPanelProps = {
  autoRefreshUsage: boolean;
  defaultTab: AppTab;
  languageOptions: Option<Locale>[];
  locale: Locale;
  onAutoRefreshUsageChange: (enabled: boolean) => void;
  onDefaultTabChange: (tab: AppTab) => void;
  onLocaleChange: (locale: Locale) => void;
  onOpenCodexDirectory: () => void;
  onPrivateModeChange: (enabled: boolean) => void;
  onRevealVault: () => void;
  onThemeChange: (theme: ThemeMode) => void;
  status: AppStatus | null;
  t: Translate;
  theme: ThemeMode;
  themeOptions: Option<ThemeMode>[];
  privateMode: boolean;
};

function SegmentedControl<T extends string>({
  ariaLabel,
  disabled = false,
  onChange,
  options,
  value,
}: {
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: T) => void;
  options: Option<T>[];
  value: T;
}) {
  return (
    <div className="settings-segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "active" : ""}
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsPanel({
  autoRefreshUsage,
  defaultTab,
  languageOptions,
  locale,
  onAutoRefreshUsageChange,
  onDefaultTabChange,
  onLocaleChange,
  onOpenCodexDirectory,
  onPrivateModeChange,
  onRevealVault,
  onThemeChange,
  status,
  t,
  theme,
  themeOptions,
  privateMode,
}: SettingsPanelProps) {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateSource, setUpdateSource] =
    useState<AppUpdateSource>(storedUpdateSource);
  const [appUpdate, setAppUpdate] = useState<AppUpdateCheckResult | null>(null);
  const [updateError, setUpdateError] = useState<UpdateError | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateDownloaded, setUpdateDownloaded] = useState(0);
  const [updateTotal, setUpdateTotal] = useState<number | null>(null);
  const [diagnostics, setDiagnostics] = useState<LocalDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const updateTotalRef = useRef<number | null>(null);
  const tabOptions: Option<AppTab>[] = [
    { label: t("accountsTab"), value: "accounts" },
    { label: t("configTab"), value: "config" },
    { label: t("usageTab"), value: "usage" },
    { label: t("quotaTab"), value: "quota" },
    { label: t("settingsTab"), value: "settings" },
  ];
  const runUpdateCheck = useCallback(async () => {
    setCheckingUpdate(true);
    setUpdateError(null);
    try {
      const result = await checkAppUpdate(updateSource);
      setAppUpdate(result);
      setAppVersion(result.currentVersion);
    } catch (error) {
      setUpdateError({
        phase: "check",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCheckingUpdate(false);
    }
  }, [updateSource]);

  const runDiagnostics = useCallback(async () => {
    setDiagnosticsLoading(true);
    setDiagnosticsError(null);
    try {
      setDiagnostics(await getLocalDiagnostics());
    } catch {
      setDiagnosticsError(t("localDiagnosticsFailed"));
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    window.localStorage.setItem(UPDATE_SOURCE_STORAGE_KEY, updateSource);
  }, [updateSource]);

  useEffect(() => {
    void runDiagnostics();
  }, [runDiagnostics]);

  useEffect(() => {
    void getAppVersion()
      .then(setAppVersion)
      .catch(() => undefined);
    void runUpdateCheck();
  }, [runUpdateCheck]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen("app-update-event", (event) => {
      const payload = event.payload as
        | { event: "started"; data: { contentLength: number | null } }
        | { event: "progress"; data: { chunkLength: number } }
        | { event: "finished"; data: Record<string, never> };

      if (payload.event === "started") {
        updateTotalRef.current = payload.data.contentLength;
        setUpdateDownloaded(0);
        setUpdateTotal(payload.data.contentLength);
      } else if (payload.event === "progress") {
        setUpdateDownloaded((current) => current + payload.data.chunkLength);
      } else {
        setUpdateDownloaded((current) =>
          updateTotalRef.current
            ? Math.max(current, updateTotalRef.current)
            : current,
        );
      }
    })
      .then((stopListening) => {
        if (cancelled) {
          stopListening();
        } else {
          unlisten = stopListening;
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const installUpdate = useCallback(async () => {
    setInstallingUpdate(true);
    setUpdateError(null);
    setUpdateDownloaded(0);
    setUpdateTotal(null);
    updateTotalRef.current = null;
    try {
      await installAppUpdate();
    } catch (error) {
      setUpdateError({
        phase: "install",
        message: error instanceof Error ? error.message : String(error),
      });
      setInstallingUpdate(false);
    }
  }, []);

  const updateProgress =
    updateTotal && updateTotal > 0
      ? Math.min(100, Math.round((updateDownloaded / updateTotal) * 100))
      : null;
  const updateStatus =
    updateError?.phase === "install"
      ? t("appUpdateInstallFailed")
      : updateError?.phase === "check"
        ? t("appUpdateCheckFailed")
        : appUpdate?.status === "available"
          ? t("appUpdateAvailable", { version: appUpdate.version ?? "" })
          : appUpdate?.status === "upToDate"
            ? t("appUpdateUpToDate")
            : appUpdate?.status === "unsupported"
              ? t("appUpdateUnsupported")
              : appUpdate?.status === "error"
                ? t("appUpdateCheckFailed")
                : t("appUpdateCheckingHint");
  const diagnosticsStatus = diagnostics
    ? diagnostics.health === "healthy"
      ? t("diagnosticsHealthy")
      : diagnostics.health === "attention"
        ? t("diagnosticsAttention")
        : t("diagnosticsError")
    : diagnosticsLoading
      ? t("runningLocalDiagnostics")
      : t("localDiagnosticsFailed");
  const diagnosticsDate = diagnostics
    ? new Intl.DateTimeFormat(locale, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(diagnostics.generatedAt * 1000)
    : null;
  return (
    <div className="settings-page">
      <header className="page-heading">
        <span className="eyebrow">{t("preferences")}</span>
        <h2>{t("settingsTitle")}</h2>
        <p>{t("settingsDescription")}</p>
      </header>

      <div className="settings-grid">
        <section className="settings-group">
          <div className="settings-group-heading">
            <h3>{t("generalSettings")}</h3>
            <p>{t("generalSettingsHint")}</p>
          </div>

          <div className="settings-row">
            <div>
              <strong>{t("appLanguage")}</strong>
              <span>{t("appLanguageHint")}</span>
            </div>
            <SegmentedControl
              ariaLabel={t("appLanguage")}
              options={languageOptions}
              value={locale}
              onChange={onLocaleChange}
            />
          </div>

          <div className="settings-row">
            <div>
              <strong>{t("privacyMode")}</strong>
              <span>{t("privacyModeHint")}</span>
            </div>
            <button
              type="button"
              className={`toggle${privateMode ? " active" : ""}`}
              role="switch"
              aria-checked={privateMode}
              aria-label={t("privacyMode")}
              onClick={() => onPrivateModeChange(!privateMode)}
            >
              <span />
            </button>
          </div>

          <div className="settings-row">
            <div>
              <strong>{t("appearance")}</strong>
              <span>{t("appearanceHint")}</span>
            </div>
            <SegmentedControl
              ariaLabel={t("appearance")}
              options={themeOptions}
              value={theme}
              onChange={onThemeChange}
            />
          </div>

          <div className="settings-row">
            <div>
              <strong>{t("defaultTab")}</strong>
              <span>{t("defaultTabHint")}</span>
            </div>
            <SegmentedControl
              ariaLabel={t("defaultTab")}
              options={tabOptions}
              value={defaultTab}
              onChange={onDefaultTabChange}
            />
          </div>
        </section>

        <section className="settings-group">
          <div className="settings-group-heading">
            <h3>{t("usageSettings")}</h3>
            <p>{t("usageSettingsHint")}</p>
          </div>

          <div className="settings-row">
            <div>
              <strong>{t("autoRefreshUsage")}</strong>
              <span>{t("autoRefreshUsageHint")}</span>
            </div>
            <button
              type="button"
              className={`toggle${autoRefreshUsage ? " active" : ""}`}
              role="switch"
              aria-checked={autoRefreshUsage}
              aria-label={t("autoRefreshUsage")}
              onClick={() => onAutoRefreshUsageChange(!autoRefreshUsage)}
            >
              <span />
            </button>
          </div>
        </section>

        <section className="settings-group settings-data-group">
          <div className="settings-group-heading">
            <h3>{t("localData")}</h3>
            <p>{t("localDataHint")}</p>
          </div>

          <dl className="settings-paths">
            <div className="settings-path-item">
              <dt>{t("codexDirectory")}</dt>
              <dd>{status?.codexHome}</dd>
              <button
                type="button"
                className="button secondary compact"
                disabled={!status?.codexHome}
                onClick={onOpenCodexDirectory}
              >
                {t("openCodexDirectory")}
              </button>
            </div>
            <div className="settings-path-item">
              <dt>{t("localVaultPath")}</dt>
              <dd>{status?.vaultPath}</dd>
              <button
                type="button"
                className="button secondary compact"
                disabled={!status?.vaultPath}
                onClick={onRevealVault}
              >
                {t("openVaultDirectory")}
              </button>
            </div>
          </dl>

          <p className="settings-privacy-note">{t("credentialPrivacy")}</p>
        </section>

        <section className="settings-group settings-diagnostics-group">
          <div className="settings-group-heading">
            <h3>{t("localDiagnostics")}</h3>
            <p>{t("localDiagnosticsHint")}</p>
          </div>

          <div className="diagnostics-overview">
            <div
              className={`diagnostics-health ${diagnostics?.health ?? "pending"}`}
              aria-live="polite"
            >
              <i aria-hidden="true" />
              <div>
                <strong>{diagnosticsStatus}</strong>
                {diagnostics && (
                  <span>
                    {t("diagnosticsSummary", {
                      pass: diagnostics.passCount,
                      warning: diagnostics.warningCount,
                      error: diagnostics.errorCount,
                    })}
                  </span>
                )}
                {diagnosticsDate && (
                  <small>
                    {t("diagnosticsCheckedAt", { date: diagnosticsDate })}
                  </small>
                )}
              </div>
            </div>
            <button
              type="button"
              className="button secondary compact"
              disabled={diagnosticsLoading}
              onClick={() => void runDiagnostics()}
            >
              {diagnosticsLoading
                ? t("runningLocalDiagnostics")
                : t("runLocalDiagnostics")}
            </button>
          </div>

          {diagnosticsError && (
            <p className="diagnostics-error">{diagnosticsError}</p>
          )}

          {diagnostics && (
            <div className="diagnostics-list">
              {diagnostics.checks.map((check) => (
                <article
                  className={`diagnostic-item level-${check.level}`}
                  key={check.id}
                >
                  <span className="diagnostic-level" aria-hidden="true" />
                  <div>
                    <strong>{t(diagnosticTitleKeys[check.id])}</strong>
                    <p>{diagnosticDetail(check, t)}</p>
                  </div>
                </article>
              ))}
            </div>
          )}

          <p className="diagnostics-privacy-note">{t("diagnosticsPrivacy")}</p>
        </section>

        <section className="settings-group settings-update-group">
          <div className="settings-group-heading">
            <h3>{t("softwareUpdate")}</h3>
            <p>{t("softwareUpdateHint")}</p>
          </div>

          <div className="settings-row">
            <div>
              <strong>{t("updateSource")}</strong>
              <span>{t("updateSourceHint")}</span>
            </div>
            <SegmentedControl
              ariaLabel={t("updateSource")}
              disabled={checkingUpdate || installingUpdate}
              options={[
                { label: "GitHub", value: "github" },
                { label: "CNB", value: "cnb" },
              ]}
              value={updateSource}
              onChange={(source) => {
                setAppUpdate(null);
                setUpdateError(null);
                setUpdateSource(source);
              }}
            />
          </div>

          <div className="settings-row">
            <div>
              <strong>{t("currentVersion")}</strong>
              <span>{appVersion ? `v${appVersion}` : t("loadingVersion")}</span>
            </div>
            <button
              type="button"
              className="button secondary compact"
              disabled={checkingUpdate || installingUpdate}
              onClick={() => void runUpdateCheck()}
            >
              {checkingUpdate ? t("checkingUpdate") : t("checkForUpdates")}
            </button>
          </div>

          <div
            className="settings-row settings-update-status"
            aria-live="polite"
          >
            <div>
              <strong>{updateStatus}</strong>
              {(updateError || appUpdate?.reason) && (
                <span>{updateError?.message ?? appUpdate?.reason}</span>
              )}
              {updateError?.phase === "install" &&
                updateSource === "github" && (
                  <span>{t("appUpdateGitHubFallbackHint")}</span>
                )}
              {installingUpdate && (
                <span>
                  {updateProgress === null
                    ? t("appUpdateDownloading")
                    : t("appUpdateDownloadingProgress", {
                        progress: updateProgress,
                      })}
                </span>
              )}
            </div>
            {appUpdate?.status === "available" && (
              <button
                type="button"
                className="button primary compact"
                disabled={installingUpdate}
                onClick={() => void installUpdate()}
              >
                {installingUpdate
                  ? t("appUpdateInstalling")
                  : t("installUpdate")}
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
