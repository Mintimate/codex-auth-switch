import { useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import type { AccountQuota, AccountSummary } from "./api";
import type { Locale, Translate } from "./i18n";
import { redactEmails } from "./privacy";
import { QuotaAccountTable } from "./QuotaAccountTable";
import { QuotaActivityOverview } from "./QuotaActivityOverview";
import { QuotaDetailDialog } from "./QuotaDetailDialog";
import {
  formatCount,
  formatDate,
  formatRelative,
  quotaEvents,
  summarizeQuotas,
} from "./quotaView";
import type { QuotaDetailView } from "./quotaView";

type QuotaPanelProps = {
  accounts: AccountSummary[];
  refreshingIds: string[];
  refreshErrors: Record<string, string>;
  onRefreshAccount: (profileId: string) => void;
  activeAccountId: string | null;
  error: string | null;
  loading: boolean;
  locale: Locale;
  onRefresh: () => void;
  privateMode: boolean;
  quotas: AccountQuota[] | null;
  t: Translate;
};

function QuotaSummary({
  detail,
  label,
  value,
  tone,
}: {
  detail: string;
  label: string;
  value: string;
  tone?: "usage" | "credits";
}) {
  return (
    <div className={`quota-overview-stat${tone ? ` ${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

export function QuotaPanel({
  accounts,
  refreshingIds,
  refreshErrors,
  onRefreshAccount,
  activeAccountId,
  error,
  loading,
  locale,
  onRefresh,
  privateMode,
  quotas,
  t,
}: QuotaPanelProps) {
  const [detail, setDetail] = useState<{
    id: string;
    view: QuotaDetailView;
  } | null>(null);
  const displayLabel = (label: string) =>
    privateMode ? redactEmails(label, t("emailHidden")) : label;
  const byProfile = new Map(accounts.map((account) => [account.id, account]));
  const visibleQuotas = (quotas ?? []).flatMap((quota) => {
    const account = byProfile.get(quota.profileId);
    return account ? [{ ...quota, label: account.label }] : [];
  });
  const events = quotaEvents(
    visibleQuotas.filter((quota) => quota.success),
    t,
  );
  const summary = summarizeQuotas(visibleQuotas);
  const uniqueAccounts = new Set(accounts.map((account) => account.accountId))
    .size;
  const selectedAccount = detail ? byProfile.get(detail.id) : undefined;

  return (
    <section className="quota-section">
      <div className="section-heading usage-heading">
        <div>
          <span className="eyebrow">{t("quotaOverview")}</span>
          <h2>{t("quotaTitle")}</h2>
        </div>
        <button
          className="text-button quota-refresh-all"
          disabled={loading || !accounts.length}
          onClick={onRefresh}
        >
          <RefreshCw
            size={15}
            className={loading ? "quota-icon-spinning" : ""}
            aria-hidden="true"
          />
          {loading ? t("queryingQuota") : t("refreshQuota")}
        </button>
      </div>
      {error && (
        <div className="usage-inline-error">
          <span>{error}</span>
          <button type="button" onClick={onRefresh}>
            {t("retry")}
          </button>
        </div>
      )}
      {loading && (
        <p className="quota-refresh-progress" role="status" aria-live="polite">
          {t("quotaAccountsRefreshing", { count: refreshingIds.length })}
        </p>
      )}
      {accounts.length ? (
        <div className="quota-loaded-content">
          <div className="quota-overview-stats">
            <QuotaSummary
              label={t("quotaAccountTotal")}
              value={String(uniqueAccounts)}
              detail={t("quotaLoadedCount", {
                count: summary.successful,
                total: uniqueAccounts,
              })}
            />
            <QuotaSummary
              label={t("quotaSevenDaysTotal")}
              value={formatCount(summary.sevenDays.tokens, locale)}
              tone="usage"
              detail={t("quotaUsageCoverage", {
                count: summary.sevenDays.count,
                total: uniqueAccounts,
              })}
            />
            <QuotaSummary
              label={t("quotaThirtyDaysTotal")}
              value={formatCount(summary.thirtyDays.tokens, locale)}
              tone="usage"
              detail={t("quotaUsageCoverage", {
                count: summary.thirtyDays.count,
                total: uniqueAccounts,
              })}
            />
            <QuotaSummary
              label={t("availableResetCredits")}
              value={
                summary.credits === null
                  ? "—"
                  : t("resetCreditCount", { count: summary.credits })
              }
              tone="credits"
              detail={t("quotaCreditCoverage", {
                count: summary.creditAccounts,
                total: uniqueAccounts,
              })}
            />
          </div>
          <QuotaActivityOverview
            accounts={accounts}
            quotas={visibleQuotas}
            displayLabel={displayLabel}
            locale={locale}
            t={t}
          />
          <QuotaAccountTable
            accounts={accounts}
            activeAccountId={activeAccountId}
            quotas={visibleQuotas}
            refreshingIds={refreshingIds}
            refreshErrors={refreshErrors}
            displayLabel={displayLabel}
            onRefresh={onRefreshAccount}
            onDetails={(id, view) => setDetail({ id, view })}
            locale={locale}
            t={t}
          />
          <details className="quota-timeline-disclosure">
            <summary>
              <ChevronDown size={16} aria-hidden="true" />
              <strong>{t("quotaTimeline")}</strong>
              <span>
                {events[0]
                  ? `${displayLabel(events[0].accountLabel)} · ${formatRelative(events[0].at, locale)}`
                  : t("noQuotaEvents")}
              </span>
            </summary>
            {events.length ? (
              <ol className="quota-timeline">
                {events.slice(0, 8).map((event, index) => (
                  <li
                    className={event.kind}
                    key={`${event.accountId}-${event.kind}-${event.at}-${index}`}
                  >
                    <i aria-hidden="true" />
                    <div>
                      <time dateTime={new Date(event.at * 1000).toISOString()}>
                        {formatRelative(event.at, locale)}
                      </time>
                      <strong>{displayLabel(event.accountLabel)}</strong>
                      <span>{event.detail}</span>
                      <small>{formatDate(event.at, locale, true)}</small>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="quota-timeline-empty">{t("noQuotaEvents")}</p>
            )}
          </details>
          <p className="usage-privacy-note">{t("quotaPrivacy")}</p>
        </div>
      ) : (
        <div className="quota-empty standalone">{t("saveForQuota")}</div>
      )}
      {detail && selectedAccount && (
        <QuotaDetailDialog
          accounts={accounts}
          account={selectedAccount}
          activeAccountId={activeAccountId}
          displayLabel={displayLabel}
          locale={locale}
          t={t}
          initialView={detail.view}
          onAccountChange={(id) => setDetail({ ...detail, id })}
          onClose={() => setDetail(null)}
          quota={
            visibleQuotas.find(
              (quota) => quota.profileId === selectedAccount.id,
            ) ?? null
          }
          refreshing={refreshingIds.includes(selectedAccount.id)}
          refreshError={refreshErrors[selectedAccount.id] ?? null}
          onRefresh={() => onRefreshAccount(selectedAccount.id)}
        />
      )}
    </section>
  );
}
