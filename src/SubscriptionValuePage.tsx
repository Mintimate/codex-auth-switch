import { useState } from "react";
import { CircleHelp, RefreshCw } from "lucide-react";
import type { AccountQuota, AccountSummary } from "./api";
import type { Locale, Translate } from "./i18n";
import { redactEmails } from "./privacy";
import { QuotaCostPanel } from "./QuotaCostPanel";
import { GuideSpotlight } from "./PageGuide";

const GUIDE_SEEN_KEY = "codex-auth-switch-subscription-value-guide-v2";
let guideSeenThisSession = false;

function isFirstVisit() {
  if (guideSeenThisSession) return false;
  try {
    return window.localStorage.getItem(GUIDE_SEEN_KEY) !== "seen";
  } catch {
    return true;
  }
}

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
  const [guideOpen, setGuideOpen] = useState(isFirstVisit);
  function closeGuide() {
    guideSeenThisSession = true;
    try {
      window.localStorage.setItem(GUIDE_SEEN_KEY, "seen");
    } catch {
      // 存储不可用时，仍可关闭指引；本次会话内不再自动弹出。
    }
    setGuideOpen(false);
  }

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
        <div className="cost-page-actions">
          <button
            type="button"
            className="text-button"
            onClick={() => setGuideOpen(true)}
          >
            <CircleHelp size={15} aria-hidden="true" />
            {t("costWelcomeOpen")}
          </button>
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
      </div>

      {!supported ? (
        <div className="usage-empty-state" data-cost-tour="setup">
          <strong>{t("costStorageUnsupported")}</strong>
          <p>{t("costStorageUnsupportedHint")}</p>
          <button
            className="button primary"
            onClick={() => {
              if (guideOpen) closeGuide();
              onOpenConfig();
            }}
          >
            {t("codexConfigPageTitle")}
          </button>
        </div>
      ) : !accounts.length ? (
        <div className="usage-empty-state" data-cost-tour="setup">
          <strong>{t("noSavedAccounts")}</strong>
          <p>{t("noSavedAccountsHint")}</p>
          <button
            className="button primary"
            onClick={() => {
              if (guideOpen) closeGuide();
              onOpenAccounts();
            }}
          >
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
            usageLoading={loading}
            onRefreshUsage={onRefresh}
            guideOpen={guideOpen}
            onCloseGuide={closeGuide}
            displayLabel={displayLabel}
            locale={locale}
            t={t}
          />
        </>
      )}
      {guideOpen && (!supported || !accounts.length) && (
        <GuideSpotlight
          targetSelector='[data-cost-tour="setup"]'
          step={0}
          total={1}
          title={t(!supported ? "costStorageUnsupported" : "noSavedAccounts")}
          description={t(
            !supported ? "costStorageUnsupportedHint" : "noSavedAccountsHint",
          )}
          onNext={closeGuide}
          onClose={closeGuide}
          t={t}
        />
      )}
    </section>
  );
}
