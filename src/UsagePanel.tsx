import {
  AccountQuota,
  TokenBreakdown,
  UsageOverview,
  UsageWindow,
} from "./api";
import { Locale, localizeBackendError, Translate } from "./i18n";

type UsagePanelProps = {
  usage: UsageOverview | null;
  loading: boolean;
  error: string | null;
  locale: Locale;
  onRefresh: () => void;
  t: Translate;
};

const formatWindow = (minutes: number | null, t: Translate) => {
  if (!minutes) return t("quotaWindow");
  if (minutes % 1440 === 0) {
    return t("daysWindow", { count: minutes / 1440 });
  }
  if (minutes % 60 === 0) {
    return t("hoursWindow", { count: minutes / 60 });
  }
  return t("minutesWindow", { count: minutes });
};

const formatReset = (
  timestamp: number | null,
  locale: Locale,
  t: Translate,
) => {
  if (!timestamp) return t("resetUnknown");
  const date = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp * 1000);
  return t("resetsAt", { date });
};

function MetricCard({
  label,
  tokens,
  compactNumber,
  fullNumber,
  emphasis = false,
}: {
  label: string;
  tokens: TokenBreakdown;
  compactNumber: Intl.NumberFormat;
  fullNumber: Intl.NumberFormat;
  emphasis?: boolean;
}) {
  return (
    <article className={`usage-metric ${emphasis ? "emphasis" : ""}`}>
      <span>{label}</span>
      <strong title={`${fullNumber.format(tokens.totalTokens)} tokens`}>
        {compactNumber.format(tokens.totalTokens)}
      </strong>
      <small>tokens</small>
    </article>
  );
}

function QuotaWindow({
  window,
  locale,
  t,
}: {
  window: UsageWindow;
  locale: Locale;
  t: Translate;
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
      <small>{formatReset(window.resetsAt, locale, t)}</small>
    </div>
  );
}

function QuotaCard({
  quota,
  accountTokens,
  compactNumber,
  fullNumber,
  locale,
  t,
}: {
  quota: AccountQuota;
  accountTokens: TokenBreakdown | undefined;
  compactNumber: Intl.NumberFormat;
  fullNumber: Intl.NumberFormat;
  locale: Locale;
  t: Translate;
}) {
  return (
    <article className="quota-card">
      <div className="quota-account">
        <div>
          <strong>{quota.label}</strong>
          <span>
            {accountTokens ? t("localUsage30Days") : t("noLocalUsage")}
          </span>
        </div>
        <b
          title={
            accountTokens
              ? fullNumber.format(accountTokens.totalTokens)
              : undefined
          }
        >
          {accountTokens ? (
            <>
              {compactNumber.format(accountTokens.totalTokens)}
              <small>tokens</small>
            </>
          ) : (
            "—"
          )}
        </b>
      </div>
      {quota.success ? (
        <div className="quota-windows">
          {quota.primary && (
            <QuotaWindow window={quota.primary} locale={locale} t={t} />
          )}
          {quota.secondary && (
            <QuotaWindow window={quota.secondary} locale={locale} t={t} />
          )}
          {!quota.primary && !quota.secondary && (
            <p className="quota-empty">{t("noQuotaWindows")}</p>
          )}
        </div>
      ) : (
        <p className="quota-error">
          {quota.error
            ? localizeBackendError(quota.error, locale)
            : t("quotaQueryFailed")}
        </p>
      )}
    </article>
  );
}

export function UsagePanel({
  usage,
  loading,
  error,
  locale,
  onRefresh,
  t,
}: UsagePanelProps) {
  const compactNumber = new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const fullNumber = new Intl.NumberFormat(locale);
  const maxDaily = Math.max(
    1,
    ...(usage?.local.daily.map((day) => day.tokens.totalTokens) ?? []),
  );
  const byAccount = new Map(
    usage?.local.byAccount.map((account) => [
      account.accountId,
      account.tokens,
    ]),
  );
  const breakdown = usage?.local.thirtyDays;

  return (
    <section className="usage-section">
      <div className="section-heading usage-heading">
        <div>
          <span className="eyebrow">{t("usageInsight")}</span>
          <h2>{t("usageTitle")}</h2>
          <p>{t("usageDescription")}</p>
        </div>
        <button className="text-button" disabled={loading} onClick={onRefresh}>
          {loading ? t("calculating") : t("refreshUsage")}
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

      {!usage && loading ? (
        <div className="usage-loading" role="status">
          {t("usageLoading")}
        </div>
      ) : !usage ? (
        <div className="usage-empty-state">
          <strong>{t("usageNotLoaded")}</strong>
          <p>{t("usageNotLoadedHint")}</p>
          <button type="button" className="button primary" onClick={onRefresh}>
            {t("loadUsage")}
          </button>
        </div>
      ) : usage ? (
        <>
          <div className="usage-metrics">
            <MetricCard
              label={t("today")}
              tokens={usage.local.today}
              compactNumber={compactNumber}
              fullNumber={fullNumber}
              emphasis
            />
            <MetricCard
              label={t("last7Days")}
              tokens={usage.local.sevenDays}
              compactNumber={compactNumber}
              fullNumber={fullNumber}
            />
            <MetricCard
              label={t("last30Days")}
              tokens={usage.local.thirtyDays}
              compactNumber={compactNumber}
              fullNumber={fullNumber}
            />
          </div>

          <div className="usage-insights">
            <article className="trend-card">
              <div className="usage-card-title">
                <div>
                  <strong>{t("trend14Days")}</strong>
                  <span>
                    {t("usageEvents", { count: usage.local.eventsCount })}
                  </span>
                </div>
                <small>
                  {t("sessionFiles", { count: usage.local.filesScanned })}
                </small>
              </div>
              <div className="trend-bars" aria-label={t("trendAria")}>
                {usage.local.daily.map((day) => (
                  <div className="trend-column" key={day.date}>
                    <span
                      title={`${day.date} · ${fullNumber.format(day.tokens.totalTokens)} tokens`}
                      style={{
                        height: `${Math.max(5, (day.tokens.totalTokens / maxDaily) * 100)}%`,
                      }}
                    />
                    <small>{day.date.slice(8)}</small>
                  </div>
                ))}
              </div>
            </article>

            {breakdown && (
              <article className="breakdown-card">
                <div className="usage-card-title">
                  <div>
                    <strong>{t("breakdown30Days")}</strong>
                    <span>{t("breakdownHint")}</span>
                  </div>
                </div>
                <dl className="breakdown-list">
                  <div>
                    <dt>{t("input")}</dt>
                    <dd>{compactNumber.format(breakdown.inputTokens)}</dd>
                  </div>
                  <div>
                    <dt>{t("cachedInput")}</dt>
                    <dd>{compactNumber.format(breakdown.cachedInputTokens)}</dd>
                  </div>
                  <div>
                    <dt>{t("output")}</dt>
                    <dd>{compactNumber.format(breakdown.outputTokens)}</dd>
                  </div>
                  <div>
                    <dt>{t("reasoningOutput")}</dt>
                    <dd>
                      {compactNumber.format(breakdown.reasoningOutputTokens)}
                    </dd>
                  </div>
                </dl>
              </article>
            )}
          </div>

          <div className="quota-heading">
            <div>
              <strong>{t("accountUsageAndQuota")}</strong>
              <span>{t("accountUsageHint")}</span>
            </div>
            {usage.local.unassigned.totalTokens > 0 && (
              <small
                title={`${fullNumber.format(usage.local.unassigned.totalTokens)} tokens`}
              >
                {t("unassignedHistory", {
                  tokens: compactNumber.format(
                    usage.local.unassigned.totalTokens,
                  ),
                })}
              </small>
            )}
          </div>
          {usage.quotas.length ? (
            <div className="quota-list">
              {usage.quotas.map((quota) => (
                <QuotaCard
                  key={quota.profileId}
                  quota={quota}
                  accountTokens={byAccount.get(quota.accountId)}
                  compactNumber={compactNumber}
                  fullNumber={fullNumber}
                  locale={locale}
                  t={t}
                />
              ))}
            </div>
          ) : (
            <div className="quota-empty standalone">{t("saveForQuota")}</div>
          )}

          <p className="usage-privacy-note">{t("usagePrivacy")}</p>
        </>
      ) : null}
    </section>
  );
}
