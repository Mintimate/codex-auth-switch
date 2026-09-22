import { ChevronDown, RefreshCw } from "lucide-react";
import type { AccountQuota, UsageWindow } from "./api";
import type { Locale, Translate } from "./i18n";
import {
  formatDate,
  formatPlan,
  formatRelative,
  formatWindow,
  quotaBuckets,
  remainingQuotaPercent,
  summaryQuotaBucket,
} from "./quotaView";

type SummaryProps = {
  accountLabel: string;
  detailId: string;
  expanded: boolean;
  onToggle: () => void;
  quota: AccountQuota | null;
  refreshing: boolean;
  refreshError: string | null;
  supported: boolean;
  t: Translate;
};

export function AccountQuotaSummary({
  accountLabel,
  detailId,
  expanded,
  onToggle,
  quota,
  refreshing,
  refreshError,
  supported,
  t,
}: SummaryProps) {
  const bucket = summaryQuotaBucket(quota);
  const windows = [bucket?.primary, bucket?.secondary].filter(
    (window): window is UsageWindow => Boolean(window),
  );

  return (
    <button
      type="button"
      className="account-quota-summary"
      aria-label={t("quotaViewAccountDetails", { account: accountLabel })}
      aria-controls={detailId}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <span className="account-quota-heading">
        {t("accountQuotaRemaining")}
        {refreshing ? (
          <RefreshCw
            size={13}
            className="quota-icon-spinning"
            aria-hidden="true"
          />
        ) : (
          <ChevronDown size={13} aria-hidden="true" />
        )}
      </span>
      {bucket && bucket.id !== "codex" && (
        <span className="account-quota-model">{bucket.name ?? bucket.id}</span>
      )}
      {supported && windows.length ? (
        windows.map((window, index) => {
          const remaining = remainingQuotaPercent(window);
          return (
            <span className="account-quota-window" key={index}>
              <span className="account-quota-values">
                <span>{formatWindow(window.windowMinutes, t, true)}</span>
                <strong>{remaining === null ? "—" : `${remaining}%`}</strong>
              </span>
              {remaining !== null && (
                <span className="account-quota-track" aria-hidden="true">
                  <span style={{ width: `${remaining}%` }} />
                </span>
              )}
            </span>
          );
        })
      ) : (
        <span className="account-quota-empty">
          {t(
            !supported
              ? "accountQuotaUnsupported"
              : refreshing
                ? "queryingQuota"
                : refreshError || (quota && !quota.success)
                  ? "quotaQueryFailed"
                  : quota?.success
                    ? "accountQuotaNoWindows"
                    : "accountQuotaNotQueried",
          )}
        </span>
      )}
      {supported && refreshError && windows.length > 0 && (
        <span className="account-quota-cache-note">
          {t("quotaCachedResult")}
        </span>
      )}
    </button>
  );
}

type DetailsProps = {
  accountId: string;
  detailId: string;
  expanded: boolean;
  locale: Locale;
  onRefresh: () => void;
  quota: AccountQuota | null;
  refreshing: boolean;
  refreshDisabled: boolean;
  refreshError: string | null;
  supported: boolean;
  t: Translate;
};

export function AccountQuotaDetails({
  accountId,
  detailId,
  expanded,
  locale,
  onRefresh,
  quota,
  refreshing,
  refreshDisabled,
  refreshError,
  supported,
  t,
}: DetailsProps) {
  const buckets = quota?.success ? quotaBuckets(quota) : [];
  return (
    <div className="account-quota-details" id={detailId} hidden={!expanded}>
      <div className="account-quota-detail-heading">
        <span>
          {formatPlan(quota?.planType ?? null) ?? t("quotaAccountDetails")}
        </span>
        <button
          type="button"
          className="text-button"
          disabled={refreshDisabled || refreshing || !supported}
          onClick={onRefresh}
        >
          <RefreshCw
            size={14}
            className={refreshing ? "quota-icon-spinning" : ""}
            aria-hidden="true"
          />
          {t(refreshing ? "queryingQuota" : "refreshQuota")}
        </button>
      </div>
      {!supported ? (
        <p>{t("quotaStorageUnsupportedHint")}</p>
      ) : (
        <>
          {refreshError && (
            <p className="account-quota-error" role="status">
              {quota?.success && `${t("quotaRefreshFailedCached")} `}
              {refreshError}
            </p>
          )}
          {buckets.map((bucket) => (
            <div className="account-quota-bucket" key={bucket.id}>
              {(buckets.length > 1 || bucket.id !== "codex") && (
                <strong>
                  {bucket.name ??
                    (bucket.id === "codex"
                      ? t("defaultCodexQuota")
                      : bucket.id)}
                </strong>
              )}
              {[bucket.primary, bucket.secondary].map((window, index) => {
                if (!window) return null;
                const remaining = remainingQuotaPercent(window);
                return (
                  <div className="account-quota-reset" key={index}>
                    <span>{formatWindow(window.windowMinutes, t, true)}</span>
                    <div>
                      <strong>
                        {remaining === null
                          ? t("unknown")
                          : t("accountQuotaRemainingPercent", {
                              percent: remaining,
                            })}
                      </strong>
                      <small>
                        {window.resetsAt
                          ? t("quotaResetDetail", {
                              relative: formatRelative(window.resetsAt, locale),
                              date: formatDate(window.resetsAt, locale),
                            })
                          : t("resetUnknown")}
                      </small>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          {!buckets.some((bucket) => bucket.primary || bucket.secondary) &&
            !refreshError && (
              <p>
                {t(
                  refreshing
                    ? "quotaLoading"
                    : quota?.success
                      ? "noQuotaWindows"
                      : quota
                        ? "quotaQueryFailed"
                        : "quotaAccountNotLoaded",
                )}
              </p>
            )}
          {quota?.success && quota.resetCredits && (
            <div className="account-quota-reset">
              <span>{t("availableResetCredits")}</span>
              <strong>
                {t("resetCreditCount", {
                  count: quota.resetCredits.availableCount,
                })}
              </strong>
            </div>
          )}
          {quota && (
            <p>
              {t("quotaQueriedAt", {
                date: formatDate(quota.queriedAt, locale),
              })}
            </p>
          )}
        </>
      )}
      <p className="account-quota-id">
        {t("accountIdentifier")}: {accountId}
      </p>
    </div>
  );
}
