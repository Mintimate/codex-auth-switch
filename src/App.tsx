import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppStatus,
  copyAuthShare,
  DeviceLoginResponse,
  getAuthShareQr,
  getStatus,
  getUsageOverview,
  importAuthFromClipboard,
  importAuthFromQr,
  pollDeviceLogin,
  removeAccount,
  renameAccount,
  saveCurrent,
  startDeviceLogin,
  switchAccount,
  UsageOverview,
} from "./api";
import { localizeBackendError, Locale, useI18n } from "./i18n";
import { ThemeMode, useAppearance } from "./theme";
import { UsagePanel } from "./UsagePanel";

type DialogMode = "save" | "login" | "rename" | null;

type PendingDeviceLogin = {
  label: string;
  response: DeviceLoginResponse;
  expiresAt: number;
};

type ShareDialogState = {
  profileId: string;
  label: string;
  qrDataUrl: string | null;
  qrError: string | null;
  copied: boolean;
  copyError: string | null;
};

type RemoveDialogState = {
  profileId: string;
  label: string;
  active: boolean;
};

const shortId = (value: string) =>
  value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const GITHUB_REPOSITORY_URL = "https://github.com/Mintimate/codex-auth-switch";

function AppIcon() {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden="true">
      <g transform="translate(91 123)">
        <path
          className="app-icon-ink"
          d="M535.801 633.267c4.043 5.917 11.052 9.428 8.283 48.187-.781 10.919-11.367 33.703-37.594 34.876-5.565.249-305.882.466-316.947-.239-64.213-4.088-172.073-65.674-170.05-202.591.352-23.808-.579-222.534 1.805-244.022 1.396-12.582 5.066-55.728 40.66-103.649 41.559-55.953 99.302-69.992 109.511-72.474 19.912-4.841 20.088-5.051 246.031-3.882 86.617.448 88.2-1.28 105.043 8.958 25.411 15.447 23.088 43.265 22.399 57.077-1.993 39.944-34.316 34.301-55.444 34.264-260.446-.45-260.419-.926-283.023.37-4.035.231-22.809 3.14-40.969 14.368-49.413 30.55-49.383 87.354-49.378 95.99.046 88.003-2.315 203.949-.599 220.997.937 9.31.219 24.218 16.487 51.287 20.03 33.328 58.226 41.303 58.562 41.408 13.76 4.313 39.197 2.47 298.923 3.034 24.811.054 35.045 4.379 46.3 17.041Z"
        />
        <path
          className="app-icon-accent"
          d="M686.017 430.492c-.371 54.839.402 54.859.532 54.982.886.837 1.048.893 65.952.884 61.752-.008 63.351-1.59 72.735 7.403 7.575 7.259 6.838 12.686 6.666 53.736-.103 24.493-23.513 24.508-26.395 24.51-117.281.075-117.649-.535-118.87.661-2.387 2.338 1.307 52.544-2.069 62.852-5.497 16.785-25.399 29.158-48.097 7.009-8.891-8.676-94.499-87.172-97.985-93.02-12.139-20.363 6.682-34.626 13.831-42.18 92.35-97.569 92.235-97.705 94.156-98.87 14.877-9.028 37.733-4.855 39.544 22.033Z"
        />
        <path
          className="app-icon-accent"
          d="M705.387 257.483c.079-62.054-3.836-69.452 16.136-78.928 4.94-2.343 17.463-1.687 22.793 2.222 6.896 5.056 6.345 5.579 97.816 103.059 4.263 4.544 15.325 14.188 13.656 27.699-1.229 9.956-4.937 12.628-43.498 49.747-65.287 62.848-66.24 63.073-73.897 64.88-6.221 1.469-22.386 4.469-31.776-14.708-3.064-6.259.37-62.975-2.16-65.903-1.074-1.242-1.39-1.226-92.956-1.247-30.734-.007-43.219 2.717-50.153-13.744-1.401-3.324-2.784-6.606-1.782-45.057.803-30.824 25.193-26.377 48.934-26.364 31.335.018 31.255-.015 40.001.055 4.404.036 53.162.429 55.057-.555.154-.08.136-.085 1.829-1.156Z"
        />
        <path
          className="app-icon-ink"
          d="M334.3 399.515c-.362 18.973-4.878 18.954-38.843 47.935-3.086 2.633-57.314 47.502-62.301 51.629-27.617 22.851-56.012-18.861-30.606-40.522 29.801-25.407 29.681-25.472 32.273-27.673 33.266-28.245 36.227-28.736 33.578-31.278-12.422-11.914-68.946-56.976-72.195-62.933-13.165-24.141 12.423-55.48 38.342-33.232 5.643 4.845 6.036 4.272 71.319 59.649 18.549 15.735 26.34 17.495 28.433 36.425Z"
        />
        <path
          className="app-icon-ink"
          d="M352.041 499.573c-.081-1.362-.721-12.203 2.829-16.813 1.814-2.355 6.189-7.88 14.682-8.763 2.244-.233 87.829-.078 93.966.04 8.716.167 21.347 8.447 18.306 25.524-1.929 10.833-12.674 15.472-15.327 15.925-7.491 1.28-7.53.336-94.994.317-8.966-.001-17.356-5.987-19.462-16.23Z"
        />
      </g>
    </svg>
  );
}

function ThemeIcon({ mode }: { mode: ThemeMode }) {
  if (mode === "light") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="3.1" />
        <path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4" />
      </svg>
    );
  }
  if (mode === "dark") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M16.4 12.8A7 7 0 0 1 7.2 3.6 7 7 0 1 0 16.4 12.8Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="10.5" rx="2" />
      <path d="M7 17h6M10 14v3" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.56 9.56 0 0 1 12 6.82c.85 0 1.71.11 2.51.34 1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.93.36.31.68.92.68 1.86v2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </svg>
  );
}

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
    shortLabel: string;
    value: Locale;
  }[] = [
    { label: t("chinese"), shortLabel: "中", value: "zh-CN" },
    { label: t("english"), shortLabel: "EN", value: "en" },
  ];
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogMode>(null);
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
  const qrFileInput = useRef<HTMLInputElement>(null);
  const [usage, setUsage] = useState<UsageOverview | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);

  const refreshUsage = useCallback(async () => {
    setUsageLoading(true);
    setUsageError(null);
    try {
      setUsage(await getUsageOverview());
    } catch (reason) {
      setUsageError(localizeBackendError(messageOf(reason), locale));
    } finally {
      setUsageLoading(false);
    }
  }, [locale]);

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
    if (status?.supported) {
      void refreshUsage();
    }
  }, [refreshUsage, status?.supported]);

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
          void refreshUsage();
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
  }, [deviceLogin, locale, refreshUsage, t]);

  const active = useMemo(
    () => status?.accounts.find((account) => account.active) ?? null,
    [status],
  );

  const run = async (description: string, action: () => Promise<AppStatus>) => {
    setBusy(description);
    setError(null);
    setNotice(null);
    try {
      setStatus(await action());
      setNotice(t("operationComplete", { action: description }));
      void refreshUsage();
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
      try {
        await navigator.clipboard.writeText(response.userCode);
      } catch {
        // Clipboard access can be blocked by system policy; the code remains visible.
      }
      try {
        await openUrl(response.verificationUri);
      } catch {
        setNotice(t("loginCodeReady"));
      }
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
    setDialog(mode);
    setLabel(initialLabel);
    setSelectedId(profileId);
  };

  const submitDialog = async (event: FormEvent) => {
    event.preventDefault();
    const nextLabel = label.trim();
    if (!nextLabel || !dialog) return;

    setDialog(null);
    if (dialog === "save") {
      await run(t("saveCurrentLogin"), () => saveCurrent(nextLabel));
    } else if (dialog === "login") {
      await beginDeviceLogin(nextLabel);
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

  const openShareDialog = async (profileId: string, accountLabel: string) => {
    setShareDialog({
      profileId,
      label: accountLabel,
      qrDataUrl: null,
      qrError: null,
      copied: false,
      copyError: null,
    });
    try {
      const qrDataUrl = await getAuthShareQr(profileId);
      setShareDialog((current) =>
        current?.profileId === profileId ? { ...current, qrDataUrl } : current,
      );
    } catch (reason) {
      setShareDialog((current) =>
        current?.profileId === profileId
          ? {
              ...current,
              qrError: localizeBackendError(messageOf(reason), locale),
            }
          : current,
      );
    }
  };

  const copyShareToClipboard = async () => {
    if (!shareDialog) return;
    try {
      await copyAuthShare(shareDialog.profileId);
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
  ) => {
    setBusy(description);
    setError(null);
    setNotice(null);
    try {
      setStatus(await action());
      setImportDialog(false);
      setNotice(t("operationComplete", { action: description }));
      void refreshUsage();
    } catch (reason) {
      setError(localizeBackendError(messageOf(reason), locale));
    } finally {
      setBusy(null);
    }
  };

  const importQrFile = async (file: File) => {
    if (file.size > 12 * 1024 * 1024) {
      setError(t("qrTooLarge"));
      return;
    }
    const image = Array.from(new Uint8Array(await file.arrayBuffer()));
    await importAuth(t("importAndSwitch"), () => importAuthFromQr(image));
  };

  return (
    <main className="app-shell" data-tauri-drag-region>
      <header className="topbar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <div className="brand-mark" aria-hidden="true">
            <AppIcon />
          </div>
          <div className="brand-copy">
            <h1>Codex Auth Switch</h1>
            <p>{t("tagline")}</p>
          </div>
        </div>
        <div className="topbar-actions">
          <div
            className="language-switcher"
            role="group"
            aria-label={t("language")}
          >
            {languageOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={locale === option.value ? "active" : ""}
                aria-label={option.label}
                aria-pressed={locale === option.value}
                title={option.label}
                onClick={() => setLocale(option.value)}
              >
                {option.shortLabel}
              </button>
            ))}
          </div>
          <div
            className="theme-switcher"
            role="group"
            aria-label={t("appearance")}
          >
            {themeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={theme === option.value ? "active" : ""}
                aria-label={option.label}
                aria-pressed={theme === option.value}
                title={option.label}
                onClick={() => setTheme(option.value)}
              >
                <ThemeIcon mode={option.value} />
              </button>
            ))}
          </div>
          <button
            type="button"
            className="github-link"
            aria-label={t("github")}
            title={GITHUB_REPOSITORY_URL}
            onClick={() =>
              void openUrl(GITHUB_REPOSITORY_URL).catch((reason) =>
                setError(t("githubOpenFailed", { message: messageOf(reason) })),
              )
            }
          >
            <GitHubIcon />
          </button>
          <span className="unofficial">{t("localOnly")}</span>
        </div>
      </header>

      {loading ? (
        <section className="loading-card">{t("loadingStatus")}</section>
      ) : (
        <div className="content-grid">
          <section className="hero-card">
            <div className="hero-copy">
              <span className="eyebrow">{t("currentLogin")}</span>
              <h2>{active?.label ?? t("currentAccountUnsaved")}</h2>
              <p>
                {active?.email ??
                  (status?.activeAccountId
                    ? t("accountDetected", {
                        id: shortId(status.activeAccountId),
                      })
                    : t("noChatGptLogin"))}
              </p>
            </div>
            <div
              className={`status-orb ${status?.activeAccountId ? "online" : "offline"}`}
              aria-label={
                status?.activeAccountId ? t("loggedIn") : t("loggedOut")
              }
            />
            <div className="hero-actions">
              <button
                className="button secondary"
                disabled={
                  Boolean(busy) || !status?.activeAccountId || !status.supported
                }
                onClick={() =>
                  openDialog("save", active?.label ?? t("workAccount"))
                }
              >
                {t("saveCurrentLogin")}
              </button>
              <button
                className="button primary"
                disabled={Boolean(busy) || !status?.supported}
                onClick={() =>
                  openDialog(
                    "login",
                    t("numberedAccount", {
                      number: (status?.accounts.length ?? 0) + 1,
                    }),
                  )
                }
              >
                {t("loginNewAccount")}
              </button>
              <button
                className="button secondary"
                disabled={Boolean(busy) || !status?.supported}
                onClick={() => {
                  setError(null);
                  setNotice(null);
                  setImportDialog(true);
                }}
              >
                {t("importAuth")}
              </button>
            </div>
          </section>

          {!status?.supported && (
            <section className="alert warning">
              <strong>{t("unsupportedStorageTitle")}</strong>
              <span>
                {t("unsupportedStorage", {
                  mode: status?.storageMode ?? t("unknown"),
                })}
                <code>cli_auth_credentials_store = &quot;file&quot;</code>
                {locale === "zh-CN" ? "。" : "."}
              </span>
            </section>
          )}

          {error && (
            <section className="alert error">
              <strong>{t("operationFailed")}</strong>
              <span>{error}</span>
            </section>
          )}

          {notice && !error && (
            <section className="alert success" role="status" aria-live="polite">
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

          <div
            className={`dashboard-grid${status?.supported ? "" : " accounts-only"}`}
          >
            {status?.supported && (
              <UsagePanel
                usage={usage}
                loading={usageLoading}
                error={usageError}
                locale={locale}
                onRefresh={() => void refreshUsage()}
                t={t}
              />
            )}

            <div className="account-column">
              <section className="accounts-section">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">{t("localVault")}</span>
                    <h2>{t("savedAccounts")}</h2>
                  </div>
                  <button
                    className="text-button"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      void refresh();
                      void refreshUsage();
                    }}
                  >
                    {t("refresh")}
                  </button>
                </div>

                {status?.accounts.length ? (
                  <div className="account-list">
                    {status.accounts.map((account) => (
                      <article
                        className={`account-card ${account.active ? "active" : ""}`}
                        key={account.id}
                      >
                        <div className="avatar" aria-hidden="true">
                          {(account.label || account.email || "C")
                            .slice(0, 1)
                            .toUpperCase()}
                        </div>
                        <div className="account-main">
                          <div className="account-title-row">
                            <h3>{account.label}</h3>
                            {account.active && (
                              <span className="active-badge">
                                {t("current")}
                              </span>
                            )}
                          </div>
                          <p>{account.email ?? t("emailUnavailable")}</p>
                          <span className="account-id">
                            {shortId(account.accountId)}
                          </span>
                        </div>
                        <div className="account-actions">
                          {!account.active && (
                            <button
                              className="account-action primary-action"
                              disabled={Boolean(busy) || !status.supported}
                              onClick={() =>
                                void run(t("switchAccount"), () =>
                                  switchAccount(account.id),
                                )
                              }
                            >
                              {t("switchToAccount")}
                            </button>
                          )}
                          <button
                            className="account-action"
                            title={t("shareAuth")}
                            disabled={Boolean(busy) || !status.supported}
                            onClick={() =>
                              void openShareDialog(account.id, account.label)
                            }
                          >
                            {t("share")}
                          </button>
                          <button
                            className="account-action"
                            title={t("rename")}
                            disabled={Boolean(busy)}
                            onClick={() =>
                              openDialog("rename", account.label, account.id)
                            }
                          >
                            {t("rename")}
                          </button>
                          <button
                            className="account-action danger"
                            title={t("removeFromVault")}
                            disabled={Boolean(busy)}
                            onClick={() =>
                              setRemoveDialog({
                                profileId: account.id,
                                label: account.label,
                                active: account.active,
                              })
                            }
                          >
                            {t("remove")}
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <div className="empty-icon">+</div>
                    <h3>{t("noSavedAccounts")}</h3>
                    <p>{t("noSavedAccountsHint")}</p>
                  </div>
                )}
              </section>

              <footer className="paths-card">
                <div>
                  <span>{t("codexDirectory")}</span>
                  <code>{status?.codexHome}</code>
                </div>
                <div>
                  <span>{t("localVaultPath")}</span>
                  <button
                    type="button"
                    className="path-link"
                    disabled={!status?.vaultPath}
                    aria-label={t("revealVaultAria")}
                    title={t("revealVaultTitle")}
                    onClick={() => {
                      if (!status?.vaultPath) return;
                      void revealItemInDir(status.vaultPath).catch((reason) =>
                        setError(
                          t("revealVaultFailed", {
                            message: messageOf(reason),
                          }),
                        ),
                      );
                    }}
                  >
                    <code>{status?.vaultPath}</code>
                    <strong>{t("openDirectory")}</strong>
                  </button>
                </div>
                <p>{t("credentialPrivacy")}</p>
              </footer>
            </div>
          </div>
        </div>
      )}

      {busy && (
        <div className="busy-overlay" role="status">
          <div className="spinner" />
          <strong>{t("busy", { action: busy })}</strong>
          <p>{t("pleaseWait")}</p>
        </div>
      )}

      {removeDialog && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={() => setRemoveDialog(null)}
        >
          <section
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="eyebrow">{t("localVault")}</span>
            <h2 id="remove-dialog-title">
              {t("removeAccountTitle", { label: removeDialog.label })}
            </h2>
            <p>
              {t("removeAccountDescription", {
                activeSuffix: removeDialog.active
                  ? t("activeRemoveSuffix")
                  : t("inactiveRemoveSuffix"),
              })}
            </p>
            {removeDialog.active && (
              <p className="remove-dialog-note">{t("activeRemoveNote")}</p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setRemoveDialog(null)}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                className="button danger-button"
                onClick={() => void handleRemove()}
              >
                {t("removeLocalOnly")}
              </button>
            </div>
          </section>
        </div>
      )}

      {shareDialog && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={() => setShareDialog(null)}
        >
          <section
            className="dialog share-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="eyebrow">{t("authSharing")}</span>
            <h2 id="share-dialog-title">
              {t("shareAccountTitle", { label: shareDialog.label })}
            </h2>
            <p>{t("shareDescription")}</p>
            <div className="share-qr" aria-live="polite">
              {shareDialog.qrDataUrl ? (
                <img
                  src={shareDialog.qrDataUrl}
                  alt={t("shareQrAlt", { label: shareDialog.label })}
                />
              ) : shareDialog.qrError ? (
                <div className="share-qr-message">
                  <strong>{t("qrGenerationFailed")}</strong>
                  <span>{shareDialog.qrError}</span>
                </div>
              ) : (
                <div className="share-qr-message">
                  <span className="inline-spinner" />
                  <span>{t("qrGenerating")}</span>
                </div>
              )}
            </div>
            <p className="sensitive-warning">{t("shareWarning")}</p>
            {shareDialog.copied && (
              <p className="share-feedback success-text">{t("copiedHint")}</p>
            )}
            {shareDialog.copyError && (
              <p className="share-feedback error-text">
                {shareDialog.copyError}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setShareDialog(null)}
              >
                {t("done")}
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => void copyShareToClipboard()}
              >
                {shareDialog.copied ? t("copyAgain") : t("copyToClipboard")}
              </button>
            </div>
          </section>
        </div>
      )}

      {importDialog && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={() => setImportDialog(false)}
        >
          <section
            className="dialog import-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="eyebrow">{t("authImport")}</span>
            <h2 id="import-dialog-title">{t("chooseImportMethod")}</h2>
            <p>{t("importDescription")}</p>
            <div className="import-options">
              <button
                type="button"
                className="import-option"
                disabled={Boolean(busy)}
                onClick={() =>
                  void importAuth(t("importAndSwitch"), importAuthFromClipboard)
                }
              >
                <span className="import-option-icon" aria-hidden="true">
                  ⎘
                </span>
                <span>
                  <strong>{t("importClipboard")}</strong>
                  <small>{t("importClipboardHint")}</small>
                </span>
              </button>
              <button
                type="button"
                className="import-option"
                disabled={Boolean(busy)}
                onClick={() => qrFileInput.current?.click()}
              >
                <span className="import-option-icon qr-icon" aria-hidden="true">
                  ▦
                </span>
                <span>
                  <strong>{t("importQr")}</strong>
                  <small>{t("importQrHint")}</small>
                </span>
              </button>
              <input
                ref={qrFileInput}
                className="visually-hidden"
                type="file"
                aria-hidden="true"
                tabIndex={-1}
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (!file) return;
                  void importQrFile(file).catch((reason) =>
                    setError(
                      t("qrReadFailed", {
                        message: localizeBackendError(
                          messageOf(reason),
                          locale,
                        ),
                      }),
                    ),
                  );
                }}
              />
            </div>
            <p className="sensitive-warning">{t("importWarning")}</p>
            {error && <p className="share-feedback error-text">{error}</p>}
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                disabled={Boolean(busy)}
                onClick={() => setImportDialog(false)}
              >
                {t("cancel")}
              </button>
            </div>
          </section>
        </div>
      )}

      {deviceLogin && (
        <div className="dialog-backdrop">
          <section
            className="dialog device-dialog"
            role="dialog"
            aria-modal="true"
          >
            <span className="eyebrow">{t("deviceCodeLogin")}</span>
            <h2>{t("completeLoginInBrowser")}</h2>
            <p>{t("deviceLoginDescription")}</p>
            <button
              className="device-code"
              type="button"
              title={t("copyVerificationCode")}
              onClick={() => {
                void navigator.clipboard
                  .writeText(deviceLogin.response.userCode)
                  .then(() => setNotice(t("verificationCodeCopied")))
                  .catch(() => setError(t("verificationCodeCopyFailed")));
              }}
            >
              {deviceLogin.response.userCode}
            </button>
            <div className="polling-state" role="status">
              <span className="polling-dot" />
              {t("waitingBrowser")}
            </div>
            <p className="device-hint">{t("deviceLoginHint")}</p>
            <div className="dialog-actions device-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDeviceLogin(null)}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() =>
                  void openUrl(deviceLogin.response.verificationUri).catch(() =>
                    setError(t("browserOpenFailed")),
                  )
                }
              >
                {t("openLoginPage")}
              </button>
            </div>
          </section>
        </div>
      )}

      {dialog && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={() => setDialog(null)}
        >
          <form
            className="dialog"
            onSubmit={(event) => void submitDialog(event)}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="eyebrow">
              {dialog === "login"
                ? t("browserLogin")
                : dialog === "save"
                  ? t("saveCurrentLogin")
                  : t("accountName")}
            </span>
            <h2>
              {dialog === "login"
                ? t("nameNewAccount")
                : dialog === "save"
                  ? t("saveThisAccount")
                  : t("renameAccount")}
            </h2>
            <label htmlFor="account-label">{t("displayName")}</label>
            <input
              id="account-label"
              autoFocus
              maxLength={60}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={t("accountNamePlaceholder")}
            />
            {dialog === "login" && <p>{t("deviceLoginNextStep")}</p>}
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDialog(null)}
              >
                {t("cancel")}
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={!label.trim()}
              >
                {t("continue")}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

export default App;
