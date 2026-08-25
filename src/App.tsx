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

const themeOptions: { label: string; value: ThemeMode }[] = [
  { label: "亮色", value: "light" },
  { label: "暗色", value: "dark" },
  { label: "跟随系统", value: "system" },
];

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
      setUsageError(messageOf(reason));
    } finally {
      setUsageLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setStatus(await getStatus());
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setLoading(false);
    }
  }, []);

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
        setError("登录验证码已过期，请重新发起登录");
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
          setNotice("新账号登录并保存完成");
          void refreshUsage();
          return;
        }
      } catch (reason) {
        if (cancelled) return;
        setError(messageOf(reason));
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
  }, [deviceLogin, refreshUsage]);

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
      setNotice(`${description}完成`);
      void refreshUsage();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  };

  const beginDeviceLogin = async (nextLabel: string) => {
    setBusy("申请登录验证码");
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
        setNotice("验证码已生成；如浏览器未自动打开，请点击“打开登录页面”");
      }
    } catch (reason) {
      setError(messageOf(reason));
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
      await run("保存当前登录", () => saveCurrent(nextLabel));
    } else if (dialog === "login") {
      await beginDeviceLogin(nextLabel);
    } else if (selectedId) {
      await run("重命名账号", () => renameAccount(selectedId, nextLabel));
    }
  };

  const handleRemove = async () => {
    if (!removeDialog) return;
    const { profileId } = removeDialog;
    setRemoveDialog(null);
    await run("移除账号", () => removeAccount(profileId));
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
          ? { ...current, qrError: messageOf(reason) }
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
          ? { ...current, copied: false, copyError: messageOf(reason) }
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
      setNotice(`${description}完成`);
      void refreshUsage();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(null);
    }
  };

  const importQrFile = async (file: File) => {
    if (file.size > 12 * 1024 * 1024) {
      setError("二维码图片不能超过 12 MB");
      return;
    }
    const image = Array.from(new Uint8Array(await file.arrayBuffer()));
    await importAuth("导入并切换 Auth", () => importAuthFromQr(image));
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
            <p>本机 Codex 多账号切换器</p>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="theme-switcher" role="group" aria-label="外观模式">
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
            aria-label="在 GitHub 查看项目仓库"
            title={GITHUB_REPOSITORY_URL}
            onClick={() =>
              void openUrl(GITHUB_REPOSITORY_URL).catch((reason) =>
                setError(`无法打开 GitHub：${messageOf(reason)}`),
              )
            }
          >
            <GitHubIcon />
          </button>
          <span className="unofficial">纯本地 · 切换 Auth</span>
        </div>
      </header>

      {loading ? (
        <section className="loading-card">正在读取本机 Codex 登录状态…</section>
      ) : (
        <div className="content-grid">
          <section className="hero-card">
            <div className="hero-copy">
              <span className="eyebrow">当前登录</span>
              <h2>{active?.label ?? "尚未保存当前账号"}</h2>
              <p>
                {active?.email ??
                  (status?.activeAccountId
                    ? `已检测到账号 ${shortId(status.activeAccountId)}`
                    : "尚未检测到 ChatGPT 登录")}
              </p>
            </div>
            <div
              className={`status-orb ${status?.activeAccountId ? "online" : "offline"}`}
              aria-label={status?.activeAccountId ? "已登录" : "未登录"}
            />
            <div className="hero-actions">
              <button
                className="button secondary"
                disabled={
                  Boolean(busy) || !status?.activeAccountId || !status.supported
                }
                onClick={() => openDialog("save", active?.label ?? "工作账号")}
              >
                保存当前登录
              </button>
              <button
                className="button primary"
                disabled={Boolean(busy) || !status?.supported}
                onClick={() =>
                  openDialog(
                    "login",
                    `账号 ${(status?.accounts.length ?? 0) + 1}`,
                  )
                }
              >
                登录新账号
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
                导入 Auth
              </button>
            </div>
          </section>

          {!status?.supported && (
            <section className="alert warning">
              <strong>当前凭据存储模式不受支持</strong>
              <span>
                检测到 {status?.storageMode ?? "未知"}。请在 Codex config.toml
                中设置
                <code>cli_auth_credentials_store = &quot;file&quot;</code>。
              </span>
            </section>
          )}

          {error && (
            <section className="alert error">
              <strong>操作失败</strong>
              <span>{error}</span>
            </section>
          )}

          {notice && !error && (
            <section className="alert success" role="status" aria-live="polite">
              <span>{notice}</span>
              <button
                type="button"
                className="alert-close"
                aria-label="关闭提示"
                title="关闭"
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
                onRefresh={() => void refreshUsage()}
              />
            )}

            <div className="account-column">
              <section className="accounts-section">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">本机账号库</span>
                    <h2>已保存账号</h2>
                  </div>
                  <button
                    className="text-button"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      void refresh();
                      void refreshUsage();
                    }}
                  >
                    刷新
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
                              <span className="active-badge">当前</span>
                            )}
                          </div>
                          <p>{account.email ?? "未提供邮箱"}</p>
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
                                void run("切换账号", () =>
                                  switchAccount(account.id),
                                )
                              }
                            >
                              切换到此账号
                            </button>
                          )}
                          <button
                            className="account-action"
                            title="分享 Auth"
                            disabled={Boolean(busy) || !status.supported}
                            onClick={() =>
                              void openShareDialog(account.id, account.label)
                            }
                          >
                            分享
                          </button>
                          <button
                            className="account-action"
                            title="重命名"
                            disabled={Boolean(busy)}
                            onClick={() =>
                              openDialog("rename", account.label, account.id)
                            }
                          >
                            重命名
                          </button>
                          <button
                            className="account-action danger"
                            title="从本机账号库移除"
                            disabled={Boolean(busy)}
                            onClick={() =>
                              setRemoveDialog({
                                profileId: account.id,
                                label: account.label,
                                active: account.active,
                              })
                            }
                          >
                            移除
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <div className="empty-icon">+</div>
                    <h3>还没有保存账号</h3>
                    <p>
                      可以保存现有 Codex 登录，也可以通过浏览器授权添加新账号。
                    </p>
                  </div>
                )}
              </section>

              <footer className="paths-card">
                <div>
                  <span>Codex 目录</span>
                  <code>{status?.codexHome}</code>
                </div>
                <div>
                  <span>本地账号库</span>
                  <button
                    type="button"
                    className="path-link"
                    disabled={!status?.vaultPath}
                    aria-label="在文件管理器中打开本地账号库目录"
                    title="在文件管理器中显示账号库文件"
                    onClick={() => {
                      if (!status?.vaultPath) return;
                      void revealItemInDir(status.vaultPath).catch((reason) =>
                        setError(
                          `无法打开本地账号库目录：${messageOf(reason)}`,
                        ),
                      );
                    }}
                  >
                    <code>{status?.vaultPath}</code>
                    <strong>打开目录</strong>
                  </button>
                </div>
                <p>认证文件包含敏感令牌。应用不会上传、显示或写入日志。</p>
              </footer>
            </div>
          </div>
        </div>
      )}

      {busy && (
        <div className="busy-overlay" role="status">
          <div className="spinner" />
          <strong>{busy}中…</strong>
          <p>请稍候</p>
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
            <span className="eyebrow">本机账号库</span>
            <h2 id="remove-dialog-title">移除“{removeDialog.label}”？</h2>
            <p>
              这会删除该账号的本地保存副本，不会注销 ChatGPT 账号
              {removeDialog.active ? "，也不会中断当前 Codex 登录。" : "。"}
            </p>
            {removeDialog.active && (
              <p className="remove-dialog-note">
                移除后将不能再从列表切换回该账号，除非重新保存当前登录。
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setRemoveDialog(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="button danger-button"
                onClick={() => void handleRemove()}
              >
                仅从本机移除
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
            <span className="eyebrow">Auth 分享</span>
            <h2 id="share-dialog-title">分享“{shareDialog.label}”</h2>
            <p>在另一台设备打开本应用，扫描此二维码或导入剪贴板内容。</p>
            <div className="share-qr" aria-live="polite">
              {shareDialog.qrDataUrl ? (
                <img
                  src={shareDialog.qrDataUrl}
                  alt={`${shareDialog.label} 的 Auth 分享二维码`}
                />
              ) : shareDialog.qrError ? (
                <div className="share-qr-message">
                  <strong>无法生成二维码</strong>
                  <span>{shareDialog.qrError}</span>
                </div>
              ) : (
                <div className="share-qr-message">
                  <span className="inline-spinner" />
                  <span>正在本机生成二维码…</span>
                </div>
              )}
            </div>
            <p className="sensitive-warning">
              紧凑编码不是加密；二维码和剪贴板内容仍包含可登录凭据，请仅分享给你信任的设备，并避免截图留存或发送到聊天软件。
            </p>
            {shareDialog.copied && (
              <p className="share-feedback success-text">
                已复制。粘贴完成后建议清空系统剪贴板。
              </p>
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
                完成
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => void copyShareToClipboard()}
              >
                {shareDialog.copied ? "重新复制" : "复制到剪贴板"}
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
            <span className="eyebrow">Auth 导入</span>
            <h2 id="import-dialog-title">选择导入方式</h2>
            <p>导入成功后会保存该账号，并立即切换为当前 Codex 登录。</p>
            <div className="import-options">
              <button
                type="button"
                className="import-option"
                disabled={Boolean(busy)}
                onClick={() =>
                  void importAuth("导入并切换 Auth", importAuthFromClipboard)
                }
              >
                <span className="import-option-icon" aria-hidden="true">
                  ⎘
                </span>
                <span>
                  <strong>从剪贴板导入</strong>
                  <small>读取本应用生成的 Auth 分享文本</small>
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
                  <strong>导入二维码图片</strong>
                  <small>选择 PNG、JPEG、WebP 或 GIF 图片</small>
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
                    setError(`无法读取二维码图片：${messageOf(reason)}`),
                  );
                }}
              />
            </div>
            <p className="sensitive-warning">
              只导入来自可信来源的内容。分享载荷会在 Rust
              后端校验，原始令牌不会显示在界面或写入日志。
            </p>
            {error && <p className="share-feedback error-text">{error}</p>}
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                disabled={Boolean(busy)}
                onClick={() => setImportDialog(false)}
              >
                取消
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
            <span className="eyebrow">Device Code 登录</span>
            <h2>在浏览器中完成登录</h2>
            <p>
              输入下面的验证码并授权“Codex”。完成后本窗口会自动保存并切换到新账号。
            </p>
            <button
              className="device-code"
              type="button"
              title="复制验证码"
              onClick={() => {
                void navigator.clipboard
                  .writeText(deviceLogin.response.userCode)
                  .then(() => setNotice("验证码已复制"))
                  .catch(() => setError("无法复制验证码，请手动输入"));
              }}
            >
              {deviceLogin.response.userCode}
            </button>
            <div className="polling-state" role="status">
              <span className="polling-dot" />
              正在等待浏览器授权
            </div>
            <p className="device-hint">
              如果页面提示不可用，请先在 ChatGPT 安全设置中启用 Device Code
              登录；工作区账号可能需要管理员启用。
            </p>
            <div className="dialog-actions device-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDeviceLogin(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() =>
                  void openUrl(deviceLogin.response.verificationUri).catch(() =>
                    setError(
                      "无法打开浏览器，请访问 auth.openai.com/codex/device",
                    ),
                  )
                }
              >
                打开登录页面
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
                ? "浏览器登录"
                : dialog === "save"
                  ? "保存当前登录"
                  : "账号名称"}
            </span>
            <h2>
              {dialog === "login"
                ? "为新账号设置名称"
                : dialog === "save"
                  ? "保存这个账号"
                  : "重命名账号"}
            </h2>
            <label htmlFor="account-label">显示名称</label>
            <input
              id="account-label"
              autoFocus
              maxLength={60}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="例如：个人 Pro"
            />
            {dialog === "login" && (
              <p>下一步会生成一次性验证码，并打开 OpenAI 登录页面。</p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDialog(null)}
              >
                取消
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={!label.trim()}
              >
                继续
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}

export default App;
