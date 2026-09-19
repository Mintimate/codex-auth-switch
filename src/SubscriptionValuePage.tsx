import { RefreshCw } from "lucide-react";
import type { AccountQuota, AccountSummary } from "./api";
import type { Locale, Translate } from "./i18n";
import { redactEmails } from "./privacy";
import { QuotaCostPanel } from "./QuotaCostPanel";

export function SubscriptionValuePage({
  accounts,
  supported,
  quotas,
  refreshingIds,
  refreshErrors,
  loading,
  error,
  onRefresh,
  onOpenAccounts,
  onOpenConfig,
  privateMode,
  locale,
  t,
}: {
  accounts: AccountSummary[];
  supported: boolean;
  quotas: AccountQuota[] | null;
  refreshingIds: string[];
  refreshErrors: Record<string, string>;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onOpenAccounts: () => void;
  onOpenConfig: () => void;
  privateMode: boolean;
  locale: Locale;
  t: Translate;
}) {
  const displayLabel = (label: string) =>
    privateMode ? redactEmails(label, t("emailHidden")) : label;
  const byProfile = new Map(accounts.map((account) => [account.id, account]));
  // 与额度页共用快照，但不能计入已删除档案，并使用当前账号名称。
  const visibleQuotas = (quotas ?? []).flatMap((quota) => {
    const account = byProfile.get(quota.profileId);
    return account ? [{ ...quota, label: account.label }] : [];
  });
  const failedCount = accounts.filter(
    (account) => refreshErrors[account.id],
  ).length;

  return (
    <section className="subscription-value-page">
      <div className="section-heading usage-heading">
        <div>
          <span className="eyebrow">{t("costPageEyebrow")}</span>
          <h2>{t("costTitle")}</h2>
          <p>{t("costSubtitle")}</p>
        </div>
        <button
          type="button"
          className="text-button quota-refresh-all"
          disabled={!supported || loading || !accounts.length}
          onClick={onRefresh}
        >
          <RefreshCw
            size={15}
            className={loading ? "quota-icon-spinning" : ""}
            aria-hidden="true"
          />
          {loading ? t("costLoadingUsage") : t("costRefreshUsage")}
        </button>
      </div>

      {!supported ? (
        <div className="usage-empty-state">
          <strong>{t("costStorageUnsupported")}</strong>
          <p>{t("costStorageUnsupportedHint")}</p>
          <button className="button primary" onClick={onOpenConfig}>
            {t("codexConfigPageTitle")}
          </button>
        </div>
      ) : !accounts.length ? (
        <div className="usage-empty-state">
          <strong>{t("noSavedAccounts")}</strong>
          <p>{t("noSavedAccountsHint")}</p>
          <button className="button primary" onClick={onOpenAccounts}>
            {t("costOpenAccounts")}
          </button>
        </div>
      ) : (
        <>
          {(error || failedCount > 0) && (
            <div className="usage-inline-error" role="alert">
              <span>
                {error ?? t("costUsageRefreshFailed", { count: failedCount })}
              </span>
              <button type="button" disabled={loading} onClick={onRefresh}>
                {t("retry")}
              </button>
            </div>
          )}
          {loading && (
            <p
              className="quota-refresh-progress"
              role="status"
              aria-live="polite"
            >
              {t("quotaAccountsRefreshing", { count: refreshingIds.length })}
            </p>
          )}
          <QuotaCostPanel
            accounts={accounts}
            quotas={visibleQuotas}
            refreshErrors={refreshErrors}
            displayLabel={displayLabel}
            locale={locale}
            t={t}
          />
        </>
      )}
    </section>
  );
}
