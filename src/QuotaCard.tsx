import { AccountQuota, AccountSummary, UsageWindow } from "./api";
import { DailyUsageHeatmap } from "./DailyUsageHeatmap";
import { Locale, localizeBackendError, Translate } from "./i18n";
import {
  formatCalendarDay,
  formatCount,
  formatDate,
  formatDuration,
  formatPlan,
  formatRelative,
  formatWindow,
  levelLabel,
  quotaBuckets,
  quotaLevel,
  quotaWindows,
  recentTokenUsage,
} from "./quotaView";

type QuotaCardProps = {
  activeAccountId: string | null;
  accountLabel: string;
  locale: Locale;
  quota: AccountQuota | null;
  account: AccountSummary;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh: () => void;
  t: Translate;
};

function QuotaWindowRow({
  locale,
  t,
  window,
}: {
  locale: Locale;
  t: Translate;
  window: UsageWindow;
}) {
  const percent = Math.round(window.usedPercent * 10) / 10;
  const windowLabel = formatWindow(window.windowMinutes, t);
  return (
    <div className="quota-window">
      <div className="quota-window-copy">
        <span>{windowLabel}</span>
        <strong>{percent}%</strong>
      </div>
      <div
        className="quota-track"
        role="progressbar"
        aria-label={t("quotaUsed", { window: windowLabel })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </div>
      <small>
        {window.resetsAt
          ? t("quotaResetDetail", {
              relative: formatRelative(window.resetsAt, locale),
              date: formatDate(window.resetsAt, locale),
            })
          : t("resetUnknown")}
      </small>
    </div>
  );
}

export function QuotaCard({
  activeAccountId,
  accountLabel,
  account,
  refreshing,
  refreshError,
  onRefresh,
  locale,
  quota,
  t,
}: QuotaCardProps) {
  const level = quota ? quotaLevel(quota) : "unknown";
  const buckets = quota ? quotaBuckets(quota) : [];
  const plan = formatPlan(quota?.planType ?? null);
  const sevenDayUsage = quota?.officialUsage
    ? recentTokenUsage(quota.officialUsage.dailyUsageBuckets, 7)
    : null;

  return (
    <article className={`quota-card level-${level}`} aria-busy={refreshing}>
      <div className="quota-account quota-account-status">
        <div>
          <strong>{accountLabel}</strong>
          <span>
            {account.accountId === activeAccountId
              ? t("currentAccount")
              : t("savedAccount")}
          </span>
        </div>
        <div className="quota-card-actions">
          <b className={`quota-status level-${level}`}>
            {levelLabel(level, t)}
          </b>
          <button
            className="text-button"
            disabled={refreshing}
            onClick={onRefresh}
            aria-label={t("refreshAccountQuotaLabel", {
              account: accountLabel,
            })}
          >
            {refreshing ? t("queryingQuota") : t("refreshAccountQuota")}
          </button>
        </div>
      </div>

      {refreshError && quota?.success && (
        <p className="quota-error" role="status">
          {t("quotaRefreshFailedCached")}{" "}
          {localizeBackendError(refreshError, locale)}
        </p>
      )}
      {quota?.success ? (
        <>
          <div className="quota-account-facts">
            <div>
              <span>{t("subscriptionPlan")}</span>
              <strong>{plan ?? t("unknown")}</strong>
            </div>
            <div>
              <span>{t("subscriptionExpiry")}</span>
              <strong>{t("officialNotProvided")}</strong>
            </div>
            <div>
              <span>{t("quotaDataSource")}</span>
              <strong>
                {quota.source === "appServer"
                  ? t("officialAppServer")
                  : t("compatibilityFallback")}
              </strong>
            </div>
            {quota.resetCredits && (
              <div className="reset-credits">
                <span>{t("availableResetCredits")}</span>
                <strong>
                  {t("resetCreditCount", {
                    count: quota.resetCredits.availableCount,
                  })}
                </strong>
                {quota.resetCredits.expiresAt[0] && (
                  <small>
                    {t("resetCreditExpiresAt", {
                      date: formatDate(
                        quota.resetCredits.expiresAt[0],
                        locale,
                        true,
                      ),
                    })}
                  </small>
                )}
              </div>
            )}
          </div>
          <div
            className={`quota-account-details${
              quota.officialUsage ? "" : " quota-only"
            }`}
          >
            {quota.officialUsage && (
              <div className="quota-official-usage">
                <div className="quota-subsection-heading">
                  <strong>{t("officialAccountUsage")}</strong>
                  <span>{t("officialAccountUsageHint")}</span>
                </div>
                <div className="quota-official-metrics">
                  <div className="quota-recent-usage">
                    <span>{t("last7DaysTokens")}</span>
                    <strong>
                      {formatCount(sevenDayUsage?.tokens ?? null, locale)}
                    </strong>
                    <small>
                      {sevenDayUsage
                        ? t("dailyUsageRange", {
                            start: formatCalendarDay(
                              sevenDayUsage.start,
                              locale,
                            ),
                            end: formatCalendarDay(sevenDayUsage.end, locale),
                          })
                        : t("noDailyTokenUsage")}
                    </small>
                  </div>
                  <dl>
                    <div>
                      <dt>{t("lifetimeTokens")}</dt>
                      <dd>
                        {formatCount(
                          quota.officialUsage.lifetimeTokens,
                          locale,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("peakDailyTokens")}</dt>
                      <dd>
                        {formatCount(
                          quota.officialUsage.peakDailyTokens,
                          locale,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("currentStreak")}</dt>
                      <dd>
                        {quota.officialUsage.currentStreakDays === null
                          ? "—"
                          : t("daysCount", {
                              count: quota.officialUsage.currentStreakDays,
                            })}
                        {quota.officialUsage.longestStreakDays !== null && (
                          <small>
                            {t("longestStreak", {
                              count: quota.officialUsage.longestStreakDays,
                            })}
                          </small>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("longestTurn")}</dt>
                      <dd>
                        {formatDuration(
                          quota.officialUsage.longestRunningTurnSec,
                          t,
                        )}
                      </dd>
                    </div>
                  </dl>
                </div>
                {quota.officialUsage.dailyUsageBuckets.length > 0 && (
                  <DailyUsageHeatmap
                    buckets={quota.officialUsage.dailyUsageBuckets}
                    locale={locale}
                    t={t}
                  />
                )}
              </div>
            )}
            <div className="quota-windows">
              {buckets.map((bucket) => (
                <div className="quota-bucket" key={bucket.id}>
                  <div className="quota-bucket-heading">
                    <strong>{bucket.name ?? t("defaultCodexQuota")}</strong>
                    {bucket.name && <span>{t("modelSpecificQuota")}</span>}
                  </div>
                  {bucket.primary && (
                    <QuotaWindowRow
                      window={bucket.primary}
                      locale={locale}
                      t={t}
                    />
                  )}
                  {bucket.secondary && (
                    <QuotaWindowRow
                      window={bucket.secondary}
                      locale={locale}
                      t={t}
                    />
                  )}
                </div>
              ))}
              {!quotaWindows(quota).length && (
                <p className="quota-empty">{t("noQuotaWindows")}</p>
              )}
            </div>
          </div>
        </>
      ) : refreshError || quota?.error ? (
        <p className="quota-error" role="status">
          {localizeBackendError(
            refreshError ?? quota?.error ?? "额度查询失败",
            locale,
          )}
        </p>
      ) : (
        <div className="quota-pending" role="status">
          {refreshing && <span className="inline-spinner" />}
          <p>{refreshing ? t("quotaLoading") : t("quotaAccountNotLoaded")}</p>
        </div>
      )}
      {quota && (
        <small className="quota-queried-at">
          {t("quotaQueriedAt", { date: formatDate(quota.queriedAt, locale) })}
        </small>
      )}
    </article>
  );
}
