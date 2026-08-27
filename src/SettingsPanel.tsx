import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppStatus,
  AppUpdateCheckResult,
  AppUpdateSource,
  checkAppUpdate,
  getAppVersion,
  installAppUpdate,
} from "./api";
import { Locale, Translate } from "./i18n";
import { ThemeMode } from "./theme";

export type AppTab = "accounts" | "usage" | "settings";

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

type SettingsPanelProps = {
  autoRefreshUsage: boolean;
  defaultTab: AppTab;
  languageOptions: Option<Locale>[];
  locale: Locale;
  onAutoRefreshUsageChange: (enabled: boolean) => void;
  onDefaultTabChange: (tab: AppTab) => void;
  onLocaleChange: (locale: Locale) => void;
  onOpenCodexDirectory: () => void;
  onRevealVault: () => void;
  onThemeChange: (theme: ThemeMode) => void;
  status: AppStatus | null;
  t: Translate;
  theme: ThemeMode;
  themeOptions: Option<ThemeMode>[];
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
  onRevealVault,
  onThemeChange,
  status,
  t,
  theme,
  themeOptions,
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
  const updateTotalRef = useRef<number | null>(null);
  const tabOptions: Option<AppTab>[] = [
    { label: t("accountsTab"), value: "accounts" },
    { label: t("usageTab"), value: "usage" },
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

  useEffect(() => {
    window.localStorage.setItem(UPDATE_SOURCE_STORAGE_KEY, updateSource);
  }, [updateSource]);

  useEffect(() => {
    void getAppVersion()
      .then(setAppVersion)
      .catch(() => undefined);
    void runUpdateCheck();
  }, [runUpdateCheck]);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;

    let unlisten: UnlistenFn | null = null;
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
    }).then((stopListening) => {
      unlisten = stopListening;
    });
    return () => unlisten?.();
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
