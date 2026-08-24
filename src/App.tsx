import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  AppStatus,
  DeviceLoginResponse,
  getStatus,
  getUsageOverview,
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

const shortId = (value: string) =>
  value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const themeOptions: { label: string; value: ThemeMode }[] = [
  { label: "亮色", value: "light" },
  { label: "暗色", value: "dark" },
  { label: "跟随系统", value: "system" },
];

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

  const handleRemove = async (profileId: string, accountLabel: string) => {
    if (!window.confirm(`确定移除“${accountLabel}”吗？这不会注销官方账号。`)) {
      return;
    }
    await run("移除账号", () => removeAccount(profileId));
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
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
          <span className="unofficial">非官方工具 · 纯本地</span>
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
            <section className="alert success">{notice}</section>
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
                              className="button compact"
                              disabled={Boolean(busy) || !status.supported}
                              onClick={() =>
                                void run("切换账号", () =>
                                  switchAccount(account.id),
                                )
                              }
                            >
                              切换
                            </button>
                          )}
                          <button
                            className="icon-button"
                            title="重命名"
                            disabled={Boolean(busy)}
                            onClick={() =>
                              openDialog("rename", account.label, account.id)
                            }
                          >
                            编辑
                          </button>
                          <button
                            className="icon-button danger"
                            title="移除"
                            disabled={Boolean(busy) || account.active}
                            onClick={() =>
                              void handleRemove(account.id, account.label)
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
