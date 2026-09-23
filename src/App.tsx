import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppStatus,
  ModelProviderState,
  copyAuthTransfer,
  cancelDeviceLogin,
  enableFileCredentialStorage,
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
  startHostedLogin,
  getHostedLogin,
  HostedLoginStatus,
  LoginMethod,
  desktopRestartSupported,
  switchAccountWithOptions,
  SwitchPreference,
  SwitchStage,
  LocalUsageStats,
} from "./api";
import {
  HostedLoginDialog,
  hostedErrorKey,
  hostedActive,
} from "./HostedLoginDialog";
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
import { localizeBackendError, Locale, MessageKey, useI18n } from "./i18n";
import { SettingsPanel } from "./SettingsPanel";
import { LabsPanel } from "./LabsPanel";
import { CodexConfigPanel } from "./CodexConfigPanel";
import { useAppearance } from "./theme";
import { QuotaPanel } from "./QuotaPanel";
import { SubscriptionValuePage } from "./SubscriptionValuePage";
import { UsagePanel } from "./UsagePanel";
import { SwitchResultPanel } from "./SwitchResultPanel";
import type { SwitchReport } from "./SwitchResultPanel";
import { SwitchAccountDialog } from "./SwitchAccountDialog";
import { redactEmails } from "./privacy";
import { useDesktopInteractions } from "./useDesktopInteractions";
import { useAccountQuotas } from "./useAccountQuotas";

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const DEFAULT_TAB_STORAGE_KEY = "codex-auth-switch-default-tab";
const PRIVATE_MODE_STORAGE_KEY = "codex-auth-switch-private-mode";
const SWITCH_PREFERENCE_STORAGE_KEY = "codex-auth-switch-switch-preference";
const LABS_HOSTED_LOGIN_STORAGE_KEY = "codex-auth-switch-labs-hosted-login";
const switchStageKeys: Record<SwitchStage, MessageKey> = {
  checking: "switchProgressChecking",
  closing: "switchProgressClosing",
  switching: "switchProgressWriting",
  launching: "switchProgressLaunching",
};
const storedSwitchPreference = (): SwitchPreference => {
  const value = window.localStorage.getItem(SWITCH_PREFERENCE_STORAGE_KEY);
  return value === "switchOnly" || value === "restart" ? value : "ask";
};
const OAUTH_LAUNCH_ANIMATION_MS = 560;
const ACCOUNT_SWITCH_FEEDBACK_MS = 420;

const storedDefaultTab = (): AppTab => {
  const value = window.localStorage.getItem(DEFAULT_TAB_STORAGE_KEY);
  return value === "accounts" ||
    value === "config" ||
    value === "usage" ||
    value === "quota" ||
    value === "value" ||
    value === "labs" ||
    value === "settings"
    ? value
    : "accounts";
};

const storedPrivateMode = () =>
  window.localStorage.getItem(PRIVATE_MODE_STORAGE_KEY) === "true";

function App() {
  useDesktopInteractions();
  const { setTheme, theme } = useAppearance();
  const { locale, setLocale, t } = useI18n();
  const languageOptions: {
    label: string;
    value: Locale;
  }[] = [
    { label: t("chinese"), value: "zh-CN" },
    { label: t("english"), value: "en" },
  ];
  const [defaultTab, setDefaultTab] = useState<AppTab>(storedDefaultTab);
  const [activeTab, setActiveTab] = useState<AppTab>(storedDefaultTab);
  const [privateMode, setPrivateMode] = useState(storedPrivateMode);
  const [switchPreference, setSwitchPreference] = useState(
    storedSwitchPreference,
  );
  const [restartSupported, setRestartSupported] = useState(false);
  const [switchDialogId, setSwitchDialogId] = useState<string | null>(null);
  const [switchStage, setSwitchStage] = useState<SwitchStage | null>(null);
  const [switchReport, setSwitchReport] = useState<SwitchReport | null>(null);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const switchingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hostedStartError, setHostedStartError] = useState<MessageKey | null>(
    null,
  );
  const [hostedLoginEnabled, setHostedLoginEnabled] = useState(
    () => window.localStorage.getItem(LABS_HOSTED_LOGIN_STORAGE_KEY) === "true",
  );
  const [preferredLoginMethod, setLoginMethod] =
    useState<LoginMethod>("device");
  // 实验室关闭后，即使上次选择过本地登录，新登录也只走设备码。
  const loginMethod: LoginMethod = hostedLoginEnabled
    ? preferredLoginMethod
    : "device";
  const [hostedLogin, setHostedLogin] = useState<HostedLoginStatus | null>(
    null,
  );
  useEffect(() => {
    let disposed = false;
    void getHostedLogin()
      .then((session) => {
        if (!disposed && session && hostedActive(session))
          setHostedLogin((current) => current ?? session);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);
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
  const {
    quotas,
    quotaRefreshingIds,
    quotaRefreshErrors,
    quotaLoading,
    quotaError,
    backgroundRefresh,
    backgroundRefreshSaving,
    backgroundRefreshError,
    setBackgroundRefresh,
    refreshQuotas,
  } = useAccountQuotas(locale);
  const statusRef = useRef(status);
  statusRef.current = status;
  const usageRefreshInFlightRef = useRef(false);

  const refreshUsage = useCallback(async () => {
    if (usageRefreshInFlightRef.current) return;
    usageRefreshInFlightRef.current = true;
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
      usageRefreshInFlightRef.current = false;
    }
  }, [locale]);

  const refreshActiveData = useCallback(() => {
    if (activeTab === "usage") void refreshUsage();
    if (
      activeTab === "accounts" ||
      activeTab === "quota" ||
      activeTab === "value"
    )
      void refreshQuotas();
  }, [activeTab, refreshQuotas, refreshUsage]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setError(null);
      const nextStatus = await getStatus();
      statusRef.current = nextStatus;
      setStatus(nextStatus);
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
    void desktopRestartSupported()
      .then(setRestartSupported)
      .catch(() => setRestartSupported(false));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      SWITCH_PREFERENCE_STORAGE_KEY,
      switchPreference,
    );
  }, [switchPreference]);

  useEffect(() => {
    if (activeTab === "usage") void refreshUsage();
  }, [activeTab, refreshUsage]);

  useEffect(() => {
    window.localStorage.setItem(DEFAULT_TAB_STORAGE_KEY, defaultTab);
  }, [defaultTab]);

  useEffect(() => {
    window.localStorage.setItem(
      LABS_HOSTED_LOGIN_STORAGE_KEY,
      String(hostedLoginEnabled),
    );
  }, [hostedLoginEnabled]);

  useEffect(() => {
    workspaceRef.current?.scrollTo({ top: 0 });
  }, [activeTab]);

  useEffect(() => {
    window.localStorage.setItem(PRIVATE_MODE_STORAGE_KEY, String(privateMode));
  }, [privateMode]);

  useEffect(() => {
    if (!notice) return;

    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const loginCallbacksRef = useRef({ locale, t, refreshActiveData });
  loginCallbacksRef.current = { locale, t, refreshActiveData };

  const closeDeviceLogin = async () => {
    if (!deviceLogin) return;
    const deviceCode = deviceLogin.response.deviceCode;
    setDeviceLogin(null);
    setBusy(t("cancel"));
    try {
      setStatus(await cancelDeviceLogin(deviceCode));
    } catch (reason) {
      setError(localizeBackendError(messageOf(reason), locale));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!deviceLogin) return;

    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      if (Date.now() >= deviceLogin.expiresAt) {
        setError(loginCallbacksRef.current.t("loginCodeExpired"));
        setDeviceLogin(null);
        try {
          setStatus(await cancelDeviceLogin(deviceLogin.response.deviceCode));
        } catch (reason) {
          setError(
            localizeBackendError(
              messageOf(reason),
              loginCallbacksRef.current.locale,
            ),
          );
        }
        return;
      }

      try {
        const nextStatus = await pollDeviceLogin(
          deviceLogin.response.deviceCode,
        );
        if (cancelled) return;
        if (nextStatus) {
          statusRef.current = nextStatus;
          setStatus(nextStatus);
          setDeviceLogin(null);
          setNotice(loginCallbacksRef.current.t("newAccountSaved"));
          loginCallbacksRef.current.refreshActiveData();
          return;
        }
      } catch (reason) {
        if (cancelled) return;
        setError(
          localizeBackendError(
            messageOf(reason),
            loginCallbacksRef.current.locale,
          ),
        );
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
  }, [deviceLogin]);

  const run = async (
    description: string,
    action: () => Promise<AppStatus>,
    onSuccess?: () => void,
  ): Promise<void> => {
    setBusy(description);
    setError(null);
    setNotice(null);
    try {
      const nextStatus = await action();
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      setNotice(t("operationComplete", { action: description }));
      onSuccess?.();
      refreshActiveData();
    } catch (reason) {
      setError(localizeBackendError(messageOf(reason), locale));
    } finally {
      setBusy(null);
    }
  };

  const handleSwitchAccount = async (profileId: string, restart: boolean) => {
    if (busy || loading || switchingRef.current) return;
    switchingRef.current = true;
    setSwitchingId(profileId);
    setError(null);
    setNotice(null);
    setSwitchReport(null);
    setSwitchStage("checking");
    let acceptProgress = true;
    let lastStage: SwitchStage = "checking";
    try {
      // 请求立即发出；快速成功时只让局部反馈完成一个周期，不挂载全屏遮罩。
      const feedbackMs = window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches
        ? 0
        : ACCOUNT_SWITCH_FEEDBACK_MS;
      const [result] = await Promise.all([
        switchAccountWithOptions(profileId, restart, (stage) => {
          if (acceptProgress) {
            lastStage = stage;
            setSwitchStage(stage);
          }
        }),
        new Promise<void>((resolve) => window.setTimeout(resolve, feedbackMs)),
      ]);
      const nextStatus = result.status;
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      setSwitchReport({ profileId, restart: result.restart });
      refreshActiveData();
    } catch (reason) {
      setError(localizeBackendError(messageOf(reason), locale));
      setSwitchReport({
        profileId,
        restart: "failed",
        failedStage: lastStage,
      });
      // 原子写入后若持久化或 IPC 中断，重新读取真实状态，避免继续显示旧账号。
      try {
        const latest = await getStatus();
        statusRef.current = latest;
        setStatus(latest);
      } catch {
        /* 保留原始错误，用户可手动刷新。 */
      }
    } finally {
      acceptProgress = false;
      setSwitchingId(null);
      setSwitchStage(null);
      switchingRef.current = false;
    }
  };

  const requestSwitch = (profileId: string) => {
    if (busy || loading || switchingRef.current) return;
    if (
      switchPreference === "ask" ||
      (switchPreference === "restart" && !restartSupported)
    ) {
      setSwitchDialogId(profileId);
    } else {
      void handleSwitchAccount(profileId, switchPreference === "restart");
    }
  };

  const switchDialogAccount = status?.accounts.find(
    (account) => account.id === switchDialogId,
  );

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
    setHostedStartError(null);
  };

  const submitDialog = async () => {
    const nextLabel = label.trim();
    if (!nextLabel || !dialog) return;
    if (dialog === "login" && loginMethod === "hosted") {
      if (oauthTransitioningRef.current) return;
      oauthTransitioningRef.current = true;
      setOauthTransitioning(true);
      setError(null);
      try {
        setHostedStartError(null);
        setHostedLogin(await startHostedLogin(nextLabel));
        setDialog(null);
      } catch (reason) {
        setHostedStartError(hostedErrorKey(reason));
      } finally {
        oauthTransitioningRef.current = false;
        setOauthTransitioning(false);
      }
      return;
    }

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
    let historyCleanupFailed = false;
    await run(
      t("removeAccountAction"),
      async () => {
        const result = await removeAccount(profileId);
        historyCleanupFailed = result.historyCleanupFailed;
        return result.status;
      },
      () => {
        if (historyCleanupFailed) setNotice(t("accountRemovedHistoryWarning"));
      },
    );
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
      <AppSidebar
        activeTab={activeTab}
        disabled={switchingId !== null}
        onTabChange={setActiveTab}
        t={t}
      />

      <section ref={workspaceRef} className="app-workspace">
        <WorkspaceToolbar
          onError={setError}
          onPrivateModeChange={setPrivateMode}
          privateMode={privateMode}
          t={t}
        />

        {loading && !status ? (
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

            {switchStage && (
              <section
                className="alert switch-progress"
                role="status"
                aria-live="polite"
              >
                <span className="spinner" aria-hidden="true" />
                <span>{t(switchStageKeys[switchStage])}</span>
              </section>
            )}
            {switchReport && activeTab === "accounts" && (
              <SwitchResultPanel
                report={switchReport}
                status={status}
                busy={Boolean(busy) || switchingId !== null}
                privateMode={privateMode}
                locale={locale}
                t={t}
                onRetry={() => requestSwitch(switchReport.profileId)}
                onDismiss={() => setSwitchReport(null)}
              />
            )}

            {activeTab === "accounts" && (
              <AccountsPage
                hostedLoginEnabled={hostedLoginEnabled}
                busy={Boolean(busy) || loading || switchingId !== null}
                loading={loading}
                locale={locale}
                quotas={quotas}
                quotaRefreshingIds={quotaRefreshingIds}
                quotaRefreshErrors={quotaRefreshErrors}
                onRefreshQuota={(id) => void refreshQuotas(id)}
                switchingId={switchingId}
                onImport={() => {
                  setError(null);
                  setNotice(null);
                  setImportDialog(true);
                }}
                onLogin={(accountLabel) => openDialog("login", accountLabel)}
                onRefresh={() => void refresh().then(() => refreshQuotas())}
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
                onSwitch={requestSwitch}
                autoRestart={switchPreference === "restart" && restartSupported}
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
                    accounts={status.accounts}
                    refreshingIds={quotaRefreshingIds}
                    refreshErrors={quotaRefreshErrors}
                    onRefreshAccount={(id) => void refreshQuotas(id)}
                    activeAccountId={status.activeAccountId}
                    quotas={quotas}
                    loading={quotaLoading}
                    error={quotaError}
                    locale={locale}
                    onRefresh={() => void refreshQuotas()}
                    privateMode={privateMode}
                    t={t}
                  />
                ) : (
                  <div className="usage-empty-state">
                    <strong>{t("quotaStorageUnsupported")}</strong>
                    <p>{t("quotaStorageUnsupportedHint")}</p>
                    <button
                      className="button primary"
                      onClick={() => setActiveTab("config")}
                    >
                      {t("codexConfigPageTitle")}
                    </button>
                  </div>
                )}
              </div>
            )}

            {activeTab === "value" && (
              <div
                id="value-panel"
                className="tab-panel"
                role="tabpanel"
                aria-label={t("costTitle")}
              >
                <SubscriptionValuePage
                  accounts={status?.accounts ?? []}
                  supported={status?.supported ?? false}
                  quotas={quotas}
                  refreshingIds={quotaRefreshingIds}
                  refreshErrors={quotaRefreshErrors}
                  loading={quotaLoading}
                  error={quotaError}
                  onRefresh={() => void refreshQuotas()}
                  onOpenAccounts={() => setActiveTab("accounts")}
                  onOpenConfig={() => setActiveTab("config")}
                  privateMode={privateMode}
                  locale={locale}
                  t={t}
                />
              </div>
            )}

            {activeTab === "labs" && (
              <div
                id="labs-panel"
                className="tab-panel"
                role="tabpanel"
                aria-label={t("labsTab")}
              >
                <LabsPanel
                  theme={theme}
                  onThemeChange={setTheme}
                  hostedLoginEnabled={hostedLoginEnabled}
                  onHostedLoginChange={(enabled) => {
                    setHostedLoginEnabled(enabled);
                    setHostedStartError(null);
                    if (!enabled) setLoginMethod("device");
                  }}
                  onTryHostedLogin={() => {
                    if (!hostedLoginEnabled) return;
                    setLoginMethod("hosted");
                    setActiveTab("accounts");
                    openDialog(
                      "login",
                      t("numberedAccount", {
                        number: (status?.accounts.length ?? 0) + 1,
                      }),
                    );
                  }}
                  t={t}
                />
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
                  backgroundRefresh={backgroundRefresh}
                  backgroundRefreshSaving={backgroundRefreshSaving}
                  backgroundRefreshError={backgroundRefreshError}
                  onBackgroundRefreshChange={setBackgroundRefresh}
                  switchPreference={switchPreference}
                  onSwitchPreferenceChange={setSwitchPreference}
                  restartSupported={restartSupported}
                  defaultTab={defaultTab}
                  languageOptions={languageOptions}
                  locale={locale}
                  onDefaultTabChange={setDefaultTab}
                  onLocaleChange={setLocale}
                  onOpenCodexDirectory={openCodexDirectory}
                  onPrivateModeChange={setPrivateMode}
                  onRevealVault={revealVault}
                  status={status}
                  t={t}
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

      {switchDialogAccount && (
        <SwitchAccountDialog
          label={
            privateMode
              ? redactEmails(switchDialogAccount.label, t("emailHidden"))
              : switchDialogAccount.label
          }
          restartSupported={restartSupported}
          onClose={() => setSwitchDialogId(null)}
          onConfirm={(restart, remember) => {
            const id = switchDialogAccount.id;
            if (remember)
              setSwitchPreference(restart ? "restart" : "switchOnly");
            setSwitchDialogId(null);
            void handleSwitchAccount(id, restart);
          }}
          t={t}
        />
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
        onClose={() => void closeDeviceLogin()}
        t={t}
      />

      <HostedLoginDialog
        login={hostedLogin}
        onChange={setHostedLogin}
        onSaved={async () => {
          const latest = await getStatus();
          statusRef.current = latest;
          setStatus(latest);
        }}
        onSwitch={async (id) => {
          if (!statusRef.current?.supported) {
            const latest = await enableFileCredentialStorage().catch(() => {
              throw "storage";
            });
            statusRef.current = latest;
            setStatus(latest);
          }
          setHostedLogin(null);
          requestSwitch(id);
        }}
        requiresFileStorage={!status?.supported}
        onDevice={() => {
          setHostedLogin(null);
          setLoginMethod("device");
          openDialog("login", label);
        }}
        t={t}
      />
      <AccountNameDialog
        hostedLoginEnabled={hostedLoginEnabled}
        onOpenLabs={() => {
          setDialog(null);
          setActiveTab("labs");
        }}
        loginMethod={loginMethod}
        onLoginMethodChange={(method) => {
          setLoginMethod(method);
          setHostedStartError(null);
        }}
        loginError={hostedStartError ? t(hostedStartError) : null}
        label={label}
        mode={dialog}
        oauthTransitioning={oauthTransitioning}
        onClose={() => setDialog(null)}
        onLabelChange={setLabel}
        onSubmit={() => void submitDialog()}
        privateMode={privateMode}
        requiresFileStorage={
          dialog === "login" && loginMethod === "device" && !status?.supported
        }
        storageMode={status?.storageMode ?? "unsupported"}
        t={t}
      />
    </main>
  );
}

export default App;
