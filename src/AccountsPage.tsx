import { AccountFlow } from "./AccountFlow";
import type { AccountSummary, AppStatus } from "./api";
import type { Translate } from "./i18n";
import { redactEmails } from "./privacy";

const shortId = (value: string) =>
  value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;

type AccountsPageProps = {
  busy: boolean;
  onImport: () => void;
  onLogin: (label: string) => void;
  onRefresh: () => void;
  onRemove: (account: AccountSummary, displayLabel: string) => void;
  onRename: (account: AccountSummary) => void;
  onSave: (label: string) => void;
  onShare: (profileId: string, displayLabel: string) => void;
  onSwitch: (profileId: string) => void;
  privateMode: boolean;
  status: AppStatus | null;
  t: Translate;
};

export function AccountsPage({
  busy,
  onImport,
  onLogin,
  onRefresh,
  onRemove,
  onRename,
  onSave,
  onShare,
  onSwitch,
  privateMode,
  status,
  t,
}: AccountsPageProps) {
  const active = status?.accounts.find((account) => account.active) ?? null;
  const displayLabel = (value: string) =>
    privateMode ? redactEmails(value, t("emailHidden")) : value;

  return (
    <div
      id="accounts-panel"
      className="accounts-page"
      role="tabpanel"
      aria-label={t("accountsTab")}
    >
      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">{t("currentLogin")}</span>
          <h2>
            {active ? displayLabel(active.label) : t("currentAccountUnsaved")}
          </h2>
          <p>
            {active?.email
              ? privateMode
                ? t("emailHidden")
                : active.email
              : status?.activeAccountId
                ? t("accountDetected", {
                    id: shortId(status.activeAccountId),
                  })
                : t("noChatGptLogin")}
          </p>
        </div>
        <div
          className={`status-orb ${status?.activeAccountId ? "online" : "offline"}`}
          aria-label={status?.activeAccountId ? t("loggedIn") : t("loggedOut")}
        />
        <div className="hero-actions">
          <button
            className="button secondary hero-action"
            disabled={busy || !status?.activeAccountId || !status.supported}
            onClick={() => onSave(active?.label ?? t("workAccount"))}
          >
            <strong>{t("saveCurrentLogin")}</strong>
            <small>{t("saveCurrentLoginHint")}</small>
          </button>
          <button
            className="button primary hero-action"
            aria-describedby="add-account-guide"
            disabled={busy || !status?.supported}
            onClick={() =>
              onLogin(
                t("numberedAccount", {
                  number: (status?.accounts.length ?? 0) + 1,
                }),
              )
            }
          >
            <strong>{t("loginNewAccount")}</strong>
            <small>{t("loginNewAccountHint")}</small>
          </button>
          <button
            className="button secondary hero-action"
            disabled={busy || !status?.supported}
            onClick={onImport}
          >
            <strong>{t("importAuth")}</strong>
            <small>{t("importAuthHint")}</small>
          </button>
        </div>
        <p className="hero-login-guide" id="add-account-guide">
          <span className="hero-login-guide-label">
            {t("accountAddGuideLabel")}
          </span>
          <span>{t("accountAddGuide")}</span>
        </p>
      </section>

      <AccountFlow
        activeLabel={active ? displayLabel(active.label) : null}
        status={status}
        t={t}
      />

      <section className="accounts-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">{t("localVault")}</span>
            <h2>{t("savedAccounts")}</h2>
          </div>
          <button className="text-button" disabled={busy} onClick={onRefresh}>
            {t("refresh")}
          </button>
        </div>

        {status?.accounts.length ? (
          <div className="account-list">
            {status.accounts.map((account) => {
              const accountLabel = displayLabel(account.label);
              return (
                <article
                  className={`account-card ${account.active ? "active" : ""}`}
                  key={account.id}
                >
                  <div className="avatar" aria-hidden="true">
                    {(accountLabel || (privateMode ? "" : account.email) || "C")
                      .slice(0, 1)
                      .toUpperCase()}
                  </div>
                  <div className="account-main">
                    <div className="account-title-row">
                      <h3>{accountLabel}</h3>
                      {account.active && (
                        <span className="active-badge">{t("current")}</span>
                      )}
                    </div>
                    <p>
                      {account.email
                        ? privateMode
                          ? t("emailHidden")
                          : account.email
                        : t("emailUnavailable")}
                    </p>
                    <span className="account-id">
                      {shortId(account.accountId)}
                    </span>
                  </div>
                  <div className="account-actions">
                    {!account.active && (
                      <button
                        className="account-action primary-action"
                        disabled={busy || !status.supported}
                        onClick={() => onSwitch(account.id)}
                      >
                        {t("switchToAccount")}
                      </button>
                    )}
                    <button
                      className="account-action"
                      title={t("shareAuth")}
                      disabled={busy || !status.supported}
                      onClick={() => onShare(account.id, accountLabel)}
                    >
                      {t("share")}
                    </button>
                    <button
                      className="account-action"
                      title={t("rename")}
                      disabled={busy}
                      onClick={() => onRename(account)}
                    >
                      {t("rename")}
                    </button>
                    <button
                      className="account-action danger"
                      title={t("removeFromVault")}
                      disabled={busy}
                      onClick={() => onRemove(account, accountLabel)}
                    >
                      {t("remove")}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-icon">+</div>
            <h3>{t("noSavedAccounts")}</h3>
            <p>{t("noSavedAccountsHint")}</p>
          </div>
        )}
      </section>
    </div>
  );
}
