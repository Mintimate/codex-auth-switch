import { isPublicDemo } from "./runtime";
import { AccountFlow } from "./AccountFlow";
import { useState } from "react";
import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  Pencil,
  Plus,
  QrCode,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import {
  AccountQuotaDetails,
  AccountQuotaSummary,
} from "./AccountQuotaSummary";
import { SwitchAccountButton } from "./SwitchAccountButton";
import type { AccountQuota, AccountSummary, AppStatus } from "./api";
import { localizeBackendError } from "./i18n";
import type { Locale, Translate } from "./i18n";
import { redactEmails } from "./privacy";

const shortId = (value: string) =>
  value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;

type AccountsPageProps = {
  hostedLoginEnabled: boolean;
  busy: boolean;
  loading: boolean;
  locale: Locale;
  quotas: AccountQuota[] | null;
  quotaRefreshingIds: string[];
  quotaRefreshErrors: Record<string, string>;
  onRefreshQuota: (profileId: string) => void;
  switchingId: string | null;
  onImport: () => void;
  onLogin: (label: string) => void;
  onRefresh: () => void;
  onRemove: (account: AccountSummary, displayLabel: string) => void;
  onRename: (account: AccountSummary) => void;
  onSave: (label: string) => void;
  onShare: (profileId: string, displayLabel: string) => void;
  onSwitch: (profileId: string) => void;
  autoRestart: boolean;
  privateMode: boolean;
  status: AppStatus | null;
  t: Translate;
};

function AccountsListSkeleton({ label }: { label: string }) {
  return (
    <div
      className="account-list account-list-skeleton"
      role="status"
      aria-live="polite"
    >
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: 4 }, (_, index) => (
        <article className="account-card account-card-skeleton" key={index}>
          <span className="usage-skeleton-block skeleton-account-avatar" />
          <div className="account-main">
            <span className="usage-skeleton-block skeleton-account-name" />
            <span className="usage-skeleton-block skeleton-account-email" />
          </div>
          <span className="usage-skeleton-block skeleton-account-quota" />
          <div className="account-actions account-skeleton-actions">
            <span className="usage-skeleton-block" />
            <span className="usage-skeleton-block" />
            <span className="usage-skeleton-block" />
          </div>
        </article>
      ))}
    </div>
  );
}

export function AccountsPage({
  hostedLoginEnabled,
  busy,
  loading,
  locale,
  quotas,
  quotaRefreshingIds,
  quotaRefreshErrors,
  onRefreshQuota,
  switchingId,
  onImport,
  onLogin,
  onRefresh,
  onRemove,
  onRename,
  onSave,
  onShare,
  onSwitch,
  autoRestart,
  privateMode,
  status,
  t,
}: AccountsPageProps) {
  const [expandedQuotaIds, setExpandedQuotaIds] = useState<Set<string>>(
    () => new Set(),
  );
  const accounts = status?.accounts ?? [];
  const active = accounts.find((account) => account.active) ?? null;
  const allQuotasExpanded =
    accounts.length > 0 &&
    accounts.every((account) => expandedQuotaIds.has(account.id));
  const toggleAllLabel = t(
    allQuotasExpanded ? "collapseAllAccountDetails" : "expandAllAccountDetails",
  );
  const quotasByProfile = new Map(
    quotas?.map((quota) => [quota.profileId, quota]),
  );
  const quotaRefreshing = quotaRefreshingIds.length > 0;
  const refreshingAccounts = loading || quotaRefreshing;
  const displayLabel = (value: string) =>
    privateMode ? redactEmails(value, t("emailHidden")) : value;

  return (
    <div
      id="accounts-panel"
      className="accounts-page"
      role="tabpanel"
      aria-label={t("accountsTab")}
      aria-busy={switchingId !== null}
    >
      <section className="hero-card">
        <div className="hero-copy">
          <div className="hero-login-status">
            <span className="eyebrow">{t("currentLogin")}</span>
            <span
              className={`status-orb ${status?.activeAccountId ? "online" : "offline"}`}
              role="img"
              aria-label={
                status?.activeAccountId ? t("loggedIn") : t("loggedOut")
              }
            />
          </div>
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
        <div className="hero-actions">
          <button
            className="button secondary hero-action"
            title={t("saveCurrentLoginHint")}
            aria-label={t("saveCurrentLogin")}
            disabled={
              isPublicDemo ||
              busy ||
              !status?.activeAccountId ||
              !status.supported
            }
            onClick={() => onSave(active?.label ?? t("workAccount"))}
          >
            <Save size={16} aria-hidden="true" />
            {t("saveCurrentLoginCompact")}
          </button>
          <button
            className="button primary hero-action"
            aria-describedby="add-account-guide"
            title={t(
              hostedLoginEnabled
                ? "loginNewAccountHint"
                : "oauthLoginNewAccountHint",
            )}
            disabled={isPublicDemo || busy || !status}
            onClick={() =>
              onLogin(
                t("numberedAccount", {
                  number: (status?.accounts.length ?? 0) + 1,
                }),
              )
            }
          >
            <Plus size={16} aria-hidden="true" />
            {t("loginNewAccount")}
          </button>
          <button
            className="button secondary hero-action"
            aria-label={t("importAuth")}
            title={t("importAuthHint")}
            disabled={isPublicDemo || busy || !status?.supported}
            onClick={onImport}
          >
            <Download size={16} aria-hidden="true" />
            {t("importAuthCompact")}
          </button>
        </div>
        <details className="hero-login-guide">
          <summary>
            {t("accountAddGuideLabel")}
            <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <p id="add-account-guide">
            {t(hostedLoginEnabled ? "accountAddGuide" : "oauthAccountAddGuide")}
          </p>
        </details>
      </section>

      <AccountFlow
        activeLabel={active ? displayLabel(active.label) : null}
        status={status}
        t={t}
      />

      <section
        className="accounts-section"
        aria-labelledby="saved-accounts-title"
      >
        <div className="accounts-section-heading">
          <h2 id="saved-accounts-title">{t("savedAccounts")}</h2>
          <div
            className="account-list-toolbar"
            role="group"
            aria-label={t("accountListActions")}
          >
            <button
              type="button"
              className={`text-button account-toolbar-button ${allQuotasExpanded ? "active" : ""}`}
              title={toggleAllLabel}
              aria-label={toggleAllLabel}
              disabled={loading || accounts.length === 0}
              onClick={() =>
                setExpandedQuotaIds(
                  allQuotasExpanded
                    ? new Set()
                    : new Set(accounts.map((account) => account.id)),
                )
              }
            >
              {allQuotasExpanded ? (
                <ChevronsDownUp size={20} aria-hidden="true" />
              ) : (
                <ChevronsUpDown size={20} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="text-button account-toolbar-button"
              title={t(refreshingAccounts ? "refreshing" : "refresh")}
              aria-label={t(refreshingAccounts ? "refreshing" : "refresh")}
              aria-busy={refreshingAccounts}
              disabled={busy || quotaRefreshing}
              onClick={onRefresh}
            >
              <RefreshCw
                size={20}
                className={refreshingAccounts ? "quota-icon-spinning" : ""}
                aria-hidden="true"
              />
            </button>
          </div>
        </div>

        {loading ? (
          <AccountsListSkeleton label={t("loadingStatus")} />
        ) : status?.accounts.length ? (
          <div
            className={`account-list ${allQuotasExpanded ? "all-expanded" : ""}`}
          >
            {status.accounts.map((account) => {
              const accountLabel = displayLabel(account.label);
              const quota = quotasByProfile.get(account.id) ?? null;
              const rawError = quotaRefreshErrors[account.id] ?? quota?.error;
              const refreshError = rawError
                ? displayLabel(localizeBackendError(rawError, locale))
                : null;
              const expanded = expandedQuotaIds.has(account.id);
              const detailId = `account-quota-${account.id}`;
              const refreshing = quotaRefreshingIds.includes(account.id);
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
                      {account.pendingLogin && (
                        <span className="active-badge">
                          {t("hostedPendingSwitch")}
                        </span>
                      )}
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
                  </div>
                  <AccountQuotaSummary
                    accountLabel={accountLabel}
                    detailId={detailId}
                    expanded={expanded}
                    onToggle={() =>
                      setExpandedQuotaIds((current) => {
                        const next = new Set(current);
                        if (next.has(account.id)) next.delete(account.id);
                        else next.add(account.id);
                        return next;
                      })
                    }
                    quota={quota}
                    refreshing={refreshing}
                    refreshError={refreshError}
                    supported={status.supported}
                    t={t}
                  />
                  <div className="account-actions">
                    {(!account.active || account.pendingLogin) && (
                      <SwitchAccountButton
                        disabled={isPublicDemo || busy || !status.supported}
                        switching={switchingId === account.id}
                        onClick={() => onSwitch(account.id)}
                        restart={autoRestart}
                        t={t}
                      />
                    )}
                    <button
                      className="account-action account-icon-action"
                      title={t("shareAuth")}
                      aria-label={t("shareAuth")}
                      disabled={isPublicDemo || busy || !status.supported}
                      onClick={() => onShare(account.id, accountLabel)}
                    >
                      <QrCode size={17} aria-hidden="true" />
                    </button>
                    <button
                      className="account-action account-icon-action"
                      title={t("rename")}
                      aria-label={t("rename")}
                      disabled={isPublicDemo || busy}
                      onClick={() => onRename(account)}
                    >
                      <Pencil size={17} aria-hidden="true" />
                    </button>
                    <button
                      className="account-action account-icon-action danger"
                      title={t("removeFromVault")}
                      aria-label={t("removeFromVault")}
                      disabled={isPublicDemo || busy}
                      onClick={() => onRemove(account, accountLabel)}
                    >
                      <Trash2 size={17} aria-hidden="true" />
                    </button>
                  </div>
                  <AccountQuotaDetails
                    accountId={account.accountId}
                    detailId={detailId}
                    expanded={expanded}
                    locale={locale}
                    onRefresh={() => onRefreshQuota(account.id)}
                    quota={quota}
                    refreshing={refreshing}
                    refreshDisabled={busy}
                    refreshError={refreshError}
                    supported={status.supported}
                    t={t}
                  />
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
