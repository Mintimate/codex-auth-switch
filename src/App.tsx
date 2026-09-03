import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppStatus,
  AccountQuota,
  ModelProviderState,
  copyAuthTransfer,
  enableFileCredentialStorage,
  getAccountQuotas,
  getLocalUsage,
  getModelProviderState,
  prepareAuthTransfer,
  getStatus,
  importAuthFromClipboard,
  importAuthFromQr,
  pollDeviceLogin,
  removeAccount,
  renameAccount,
  saveCurrent,
  startDeviceLogin,
  switchAccount,
  LocalUsageStats,
} from "./api";
import { AccountsPage } from "./AccountsPage";
import { AppSidebar, WorkspaceToolbar } from "./AppChrome";
import type { AppTab } from "./appTypes";
import {
  AccountNameDialog,
  DeviceLoginDialog,
  DialogMode,
  ImportAuthDialog,
  PendingDeviceLogin,
  RemoveAccountDialog,
  RemoveDialogState,
  ShareAuthDialog,
  ShareDialogState,
} from "./AppDialogs";
import { localizeBackendError, Locale, useI18n } from "./i18n";
import { SettingsPanel } from "./SettingsPanel";
import { CodexConfigPanel } from "./CodexConfigPanel";
import { ThemeMode, useAppearance } from "./theme";
import { QuotaPanel } from "./QuotaPanel";
import { UsagePanel } from "./UsagePanel";

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const DEFAULT_TAB_STORAGE_KEY = "codex-auth-switch-default-tab";
const AUTO_REFRESH_USAGE_STORAGE_KEY = "codex-auth-switch-auto-refresh-usage";
const PRIVATE_MODE_STORAGE_KEY = "codex-auth-switch-private-mode";
const OAUTH_LAUNCH_ANIMATION_MS = 560;

const storedDefaultTab = (): AppTab => {
  const value = window.localStorage.getItem(DEFAULT_TAB_STORAGE_KEY);
  return value === "accounts" ||
    value === "config" ||
    value === "usage" ||
    value === "quota" ||
    value === "settings"
    ? value
    : "accounts";
};

const storedAutoRefreshUsage = () =>
  window.localStorage.getItem(AUTO_REFRESH_USAGE_STORAGE_KEY) !== "false";

const storedPrivateMode = () =>
  window.localStorage.getItem(PRIVATE_MODE_STORAGE_KEY) === "true";

function App() {
  const { setTheme, theme } = useAppearance();
  const { locale, setLocale, t } = useI18n();
  const themeOptions: { label: string; value: ThemeMode }[] = [
    { label: t("light"), value: "light" },
    { label: t("dark"), value: "dark" },
    { label: t("system"), value: "system" },
  ];
  const languageOptions: {
    label: string;
    value: Locale;
  }[] = [
    { label: t("chinese"), value: "zh-CN" },
    { label: t("english"), value: "en" },
  ];
  const [defaultTab, setDefaultTab] = useState<AppTab>(storedDefaultTab);
  const [activeTab, setActiveTab] = useState<AppTab>(storedDefaultTab);
  const [autoRefreshUsage, setAutoRefreshUsage] = useState(
    storedAutoRefreshUsage,
  );
  const [privateMode, setPrivateMode] = useState(storedPrivateMode);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [oauthTransitioning, setOauthTransitioning] = useState(false);
  const oauthTransitioningRef = useRef(false);
  const [label, setLabel] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deviceLogin, setDeviceLogin] = useState<PendingDeviceLogin | null>(
    null,
  );
  const [shareDialog, setShareDialog] = useState<ShareDialogState | null>(null);
  const [removeDialog, setRemoveDialog] = useState<RemoveDialogState | null>(
    null,
  );
  const [importDialog, setImportDialog] = useState(false);
  const workspaceRef = useRef<HTMLElement>(null);
  const [usage, setUsage] = useState<LocalUsageStats | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [modelProvider, setModelProvider] = useState<ModelProviderState | null>(
    null,
  );
  const [quotas, setQuotas] = useState<AccountQuota[] | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaError, setQuotaError] = useState<string | null>(null);

  const refreshUsage = useCallback(async () => {
    setUsageLoading(true);
    setUsageError(null);
    try {
      const [nextUsage, nextProvider] = await Promise.all([
        getLocalUsage(),
        getModelProviderState(),
      ]);
      setUsage(nextUsage);
      setModelProvider(nextProvider);
    } catch (reason) {
      setUsageError(localizeBackendError(messageOf(reason), locale));
    } finally {
      setUsageLoading(false);
    }
  }, [locale]);

  const refreshQuotas = useCallback(async () => {
    setQuotaLoading(true);
    setQuotaError(null);
    try {
      setQuotas(await getAccountQuotas());
    } catch (reason) {
      setQuotaError(localizeBackendError(messageOf(reason), locale));
    } finally {
      setQuotaLoading(false);
    }
  }, [locale]);

  const refreshActiveData = useCallback(() => {
    if (activeTab === "usage") void refreshUsage();
    if (activeTab === "quota") void refreshQuotas();
  }, [activeTab, refreshQuotas, refreshUsage]);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setStatus(await getStatus());
    } catch (reason) {
      setError(localizeBackendError(messageOf(reason), locale));
    } finally {
      setLoading(false);
    }
  }, [locale]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (autoRefreshUsage && status?.supported) refreshActiveData();
  }, [autoRefreshUsage, refreshActiveData, status?.supported]);

  useEffect(() => {
    window.localStorage.setItem(DEFAULT_TAB_STORAGE_KEY, defaultTab);
  }, [defaultTab]);

  useEffect(() => {
    workspaceRef.current?.scrollTo({ top: 0 });
  }, [activeTab]);

  useEffect(() => {
    window.localStorage.setItem(
      AUTO_REFRESH_USAGE_STORAGE_KEY,
      String(autoRefreshUsage),
    );
  }, [autoRefreshUsage]);

  useEffect(() => {
    window.localStorage.setItem(PRIVATE_MODE_STORAGE_KEY, String(privateMode));
  }, [privateMode]);

  useEffect(() => {
    if (!notice) return;

    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!deviceLogin) return;

    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      if (Date.now() >= deviceLogin.expiresAt) {
        setError(t("loginCodeExpired"));
        setDeviceLogin(null);
        return;
      }

      try {
        const nextStatus = await pollDeviceLogin(
          deviceLogin.response.deviceCode,
          deviceLogin.response.userCode,
          deviceLogin.label,
        );
        if (cancelled) return;
        if (nextStatus) {
          setStatus(nextStatus);
          setDeviceLogin(null);
          setNotice(t("newAccountSaved"));
          refreshActiveData();
          return;
        }
      } catch (reason) {
        if (cancelled) return;
        setError(localizeBackendError(messageOf(reason), locale));
        setDeviceLogin(null);
        return;
      }

      timer = window.setTimeout(
        () => void poll(),
        deviceLogin.response.interval * 1000,
      );
    };

    timer = window.setTimeout(
      () => void poll(),
      deviceLogin.response.interval * 1000,
    );
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [deviceLogin, locale, refreshActiveData, t]);

  const run = async (
    description: string,
    action: () => Promise<AppStatus>,
    onSuccess?: () => void,
  ) => {
    setBusy(description);
    setError(null);
    setNotice(null);
    try {
      setStatus(await action());
      onSuccess?.();
      setNotice(t("operationComplete", { action: description }));
      refreshActiveData();
    } catch (reason) {
      setError(localizeBackendError(messageOf(reason), locale));
    } finally {
      setBusy(null);
    }
  };

  const beginDeviceLogin = async (nextLabel: string) => {
    setBusy(t("requestLoginCode"));
    setError(null);
    setNotice(null);
    try {
      const response = await startDeviceLogin(nextLabel);
      setDeviceLogin({
        label: nextLabel,
        response,
        expiresAt: Date.now() + response.expiresIn * 1000,
      });
    } catch (reason) {
      setError(localizeBackendError(messageOf(reason), locale));
    } finally {
      setBusy(null);
    }
  };

  const openDialog = (
    mode: Exclude<DialogMode, null>,
    initialLabel = "",
    profileId: string | null = null,
  ) => {
    oauthTransitioningRef.current = false;
    setOauthTransitioning(false);
    setDialog(mode);
    setLabel(initialLabel);
    setSelectedId(profileId);
  };

  const submitDialog = async () => {
    const nextLabel = label.trim();
    if (!nextLabel || !dialog) return;

    if (dialog === "login") {
      if (oauthTransitioningRef.current) return;
      oauthTransitioningRef.current = true;
      setOauthTransitioning(true);
      if (!status?.supported) {
        setBusy(t("enableFileStorageAction"));
        setError(null);
        try {
          setStatus(await enableFileCredentialStorage());
        } catch (reason) {
          setError(localizeBackendError(messageOf(reason), locale));
          setBusy(null);
          setOauthTransitioning(false);
          oauthTransitioningRef.current = false;
          return;
        }
        setBusy(null);
      }
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        await new Promise((resolve) =>
          window.setTimeout(resolve, OAUTH_LAUNCH_ANIMATION_MS),
        );
      }
      setDialog(null);
      setOauthTransitioning(false);
      oauthTransitioningRef.current = false;
      await beginDeviceLogin(nextLabel);
      return;
    }

    setDialog(null);
    if (dialog === "save") {
      await run(t("saveCurrentLogin"), () => saveCurrent(nextLabel));
    } else if (selectedId) {
      await run(t("renameAccountAction"), () =>
        renameAccount(selectedId, nextLabel),
      );
    }
  };

  const handleRemove = async () => {
    if (!removeDialog) return;
    const { profileId } = removeDialog;
    setRemoveDialog(null);
    await run(t("removeAccountAction"), () => removeAccount(profileId));
  };

  const openShareDialog = (profileId: string, accountLabel: string) => {
    setShareDialog({
      profileId,
      label: accountLabel,
      qrDataUrl: null,
      qrError: null,
      preparing: false,
      prepared: false,
      copied: false,
      copyError: null,
    });
  };

  const prepareTransfer = async () => {
    if (!shareDialog || shareDialog.preparing) return;
    const { profileId } = shareDialog;
    setShareDialog((current) =>
      current?.profileId === profileId
        ? {
            ...current,
            qrDataUrl: null,
            qrError: null,
            preparing: true,
            prepared: false,
            copied: false,
            copyError: null,
          }
        : current,
    );
    try {
      const preparation = await prepareAuthTransfer(profileId);
      setShareDialog((current) =>
        current?.profileId === profileId
          ? {
              ...current,
              qrDataUrl: preparation.qrDataUrl,
              qrError: preparation.qrError
                ? localizeBackendError(preparation.qrError, locale)
                : null,
              preparing: false,
              prepared: true,
            }
          : current,
      );
    } catch (reason) {
      setShareDialog((current) =>
        current?.profileId === profileId
          ? {
              ...current,
              qrError: localizeBackendError(messageOf(reason), locale),
              preparing: false,
              prepared: false,
            }
          : current,
      );
    }
  };

  const copyShareToClipboard = async () => {
    if (!shareDialog) return;
    try {
      await copyAuthTransfer(shareDialog.profileId);
      setShareDialog((current) =>
        current ? { ...current, copied: true, copyError: null } : current,
      );
    } catch (reason) {
      setShareDialog((current) =>
        current
          ? {
              ...current,
              copied: false,
              copyError: localizeBackendError(messageOf(reason), locale),
            }
          : current,
      );
    }
  };

  const importAuth = async (
    description: string,
    action: () => Promise<AppStatus>,
  ) => run(description, action, () => setImportDialog(false));

  const revealVault = () => {
    if (!status?.vaultPath) return;
    void revealItemInDir(status.vaultPath).catch((reason) =>
      setError(
        t("revealVaultFailed", {
          message: messageOf(reason),
        }),
      ),
    );
  };

  const openCodexDirectory = () => {
    if (!status?.codexHome) return;
    void revealItemInDir(status.codexHome).catch((reason) =>
      setError(
        t("openCodexDirectoryFailed", {
          message: messageOf(reason),
        }),
      ),
    );
  };

  return (
    <main className="app-shell" data-tauri-drag-region>
      <AppSidebar activeTab={activeTab} onTabChange={setActiveTab} t={t} />

      <section ref={workspaceRef} className="app-workspace">
        <WorkspaceToolbar
          onError={setError}
          onPrivateModeChange={setPrivateMode}
          privateMode={privateMode}
          t={t}
        />

        {loading ? (
          <section className="loading-card">{t("loadingStatus")}</section>
        ) : (
          <div className="content-grid">
            {error && (
              <section className="alert error">
                <strong>{t("operationFailed")}</strong>
                <span>{error}</span>
              </section>
            )}

            {notice && !error && (
              <section
                className="alert success"
                role="status"
                aria-live="polite"
              >
                <span>{notice}</span>
                <button
                  type="button"
                  className="alert-close"
                  aria-label={t("closeNotice")}
                  title={t("close")}
                  onClick={() => setNotice(null)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </section>
            )}

            {activeTab === "accounts" && (
              <AccountsPage
                busy={Boolean(busy)}
                onImport={() => {
                  setError(null);
                  setNotice(null);
                  setImportDialog(true);
                }}
                onLogin={(accountLabel) => openDialog("login", accountLabel)}
                onRefresh={() => void refresh()}
                onRemove={(account, accountLabel) =>
                  setRemoveDialog({
                    profileId: account.id,
                    label: accountLabel,
                    active: account.active,
                  })
                }
                onRename={(account) =>
                  openDialog("rename", account.label, account.id)
                }
                onSave={(accountLabel) => openDialog("save", accountLabel)}
                onShare={openShareDialog}
                onSwitch={(profileId) =>
                  void run(t("switchAccount"), () => switchAccount(profileId))
                }
                privateMode={privateMode}
                status={status}
                t={t}
              />
            )}

            {activeTab === "config" && (
              <div
                id="config-panel"
                className="tab-panel"
                role="tabpanel"
                aria-label={t("configTab")}
              >
                <CodexConfigPanel
                  locale={locale}
                  onCredentialStorageChange={refresh}
                  t={t}
                />
              </div>
            )}

            {activeTab === "usage" && (
              <div
                id="usage-panel"
                className="tab-panel"
                role="tabpanel"
                aria-label={t("usageTab")}
              >
                {status?.supported ? (
                  <UsagePanel
                    usage={usage}
                    loading={usageLoading}
                    error={usageError}
                    locale={locale}
                    onRefresh={() => void refreshUsage()}
                    privateMode={privateMode}
                    t={t}
                    modelProvider={modelProvider}
                  />
                ) : null}
              </div>
            )}

            {activeTab === "quota" && (
              <div
                id="quota-panel"
                className="tab-panel"
                role="tabpanel"
                aria-label={t("quotaTab")}
              >
                {status?.supported ? (
                  <QuotaPanel
                    activeAccountId={status.activeAccountId}
                    quotas={quotas}
                    loading={quotaLoading}
                    error={quotaError}
                    locale={locale}
                    onRefresh={() => void refreshQuotas()}
                    privateMode={privateMode}
                    t={t}
                  />
                ) : null}
              </div>
            )}

            {activeTab === "settings" && (
              <div
                id="settings-panel"
                className="tab-panel"
                role="tabpanel"
                aria-label={t("settingsTab")}
              >
                <SettingsPanel
                  autoRefreshUsage={autoRefreshUsage}
                  defaultTab={defaultTab}
                  languageOptions={languageOptions}
                  locale={locale}
                  onAutoRefreshUsageChange={setAutoRefreshUsage}
                  onDefaultTabChange={setDefaultTab}
                  onLocaleChange={setLocale}
                  onOpenCodexDirectory={openCodexDirectory}
                  onPrivateModeChange={setPrivateMode}
                  onRevealVault={revealVault}
                  onThemeChange={setTheme}
                  status={status}
                  t={t}
                  theme={theme}
                  themeOptions={themeOptions}
                  privateMode={privateMode}
                />
              </div>
            )}
          </div>
        )}
      </section>

      {busy && (
        <div className="busy-overlay" role="status">
          <div className="spinner" />
          <strong>{t("busy", { action: busy })}</strong>
          <p>{t("pleaseWait")}</p>
        </div>
      )}

      <RemoveAccountDialog
        dialog={removeDialog}
        onClose={() => setRemoveDialog(null)}
        onConfirm={() => void handleRemove()}
        t={t}
      />

      <ShareAuthDialog
        dialog={shareDialog}
        onClose={() => setShareDialog(null)}
        onCopy={() => void copyShareToClipboard()}
        onPrepare={() => void prepareTransfer()}
        t={t}
      />

      <ImportAuthDialog
        busy={Boolean(busy)}
        error={error}
        locale={locale}
        onClose={() => setImportDialog(false)}
        onError={setError}
        onImportClipboard={() =>
          importAuth(t("importAndSwitch"), importAuthFromClipboard)
        }
        onImportQr={(image) =>
          importAuth(t("importAndSwitch"), () => importAuthFromQr(image))
        }
        open={importDialog}
        t={t}
      />

      <DeviceLoginDialog
        login={deviceLogin}
        onClose={() => setDeviceLogin(null)}
        t={t}
      />

      <AccountNameDialog
        label={label}
        mode={dialog}
        oauthTransitioning={oauthTransitioning}
        onClose={() => setDialog(null)}
        onLabelChange={setLabel}
        onSubmit={() => void submitDialog()}
        privateMode={privateMode}
        requiresFileStorage={dialog === "login" && !status?.supported}
        storageMode={status?.storageMode ?? "unsupported"}
        t={t}
      />
    </main>
  );
}

export default App;
