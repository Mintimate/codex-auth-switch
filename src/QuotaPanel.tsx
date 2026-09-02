import { AccountQuota, UsageWindow } from "./api";
import { Locale, localizeBackendError, Translate } from "./i18n";
import { redactEmails } from "./privacy";
import { QuotaScene } from "./QuotaScene";

type QuotaPanelProps = {
  activeAccountId: string | null;
  error: string | null;
  loading: boolean;
  locale: Locale;
  onRefresh: () => void;
  privateMode: boolean;
  quotas: AccountQuota[] | null;
  t: Translate;
};

type QuotaLevel = "healthy" | "attention" | "tight" | "unknown" | "error";

type QuotaEvent = {
  accountId: string;
  accountLabel: string;
  at: number;
  detail: string;
  kind: "reset" | "expiry";
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

const formatDate = (timestamp: number, locale: Locale, includeYear = false) =>
  new Intl.DateTimeFormat(locale, {
    ...(includeYear ? { year: "numeric" as const } : {}),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp * 1000);

const formatRelative = (timestamp: number, locale: Locale) => {
  const seconds = timestamp - Date.now() / 1000;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(seconds) < 60 * 60) {
    const minutes = Math.max(1, Math.round(Math.abs(seconds) / 60));
    return formatter.format(seconds < 0 ? -minutes : minutes, "minute");
  }
  if (Math.abs(seconds) < 48 * 60 * 60) {
    const hours = Math.max(1, Math.round(Math.abs(seconds) / 3600));
    return formatter.format(seconds < 0 ? -hours : hours, "hour");
  }
  const days = Math.max(1, Math.round(Math.abs(seconds) / 86400));
  return formatter.format(seconds < 0 ? -days : days, "day");
};

const quotaBuckets = (quota: AccountQuota) => {
  if (quota.buckets?.length) return quota.buckets;
  return [
    {
      id: "codex",
      name: null,
      primary: quota.primary,
      secondary: quota.secondary,
    },
  ];
};

const quotaWindows = (quota: AccountQuota) =>
  quotaBuckets(quota).flatMap((bucket) =>
    [bucket.primary, bucket.secondary].filter((window): window is UsageWindow =>
      Boolean(window),
    ),
  );

const quotaUtilization = (quota: AccountQuota) => {
  const windows = quotaWindows(quota);
  return windows.length
    ? Math.max(...windows.map((window) => window.usedPercent))
    : null;
};

const quotaLevel = (quota: AccountQuota): QuotaLevel => {
  if (!quota.success) return "error";
  const utilization = quotaUtilization(quota);
  if (utilization === null) return "unknown";
  if (utilization >= 90) return "tight";
  if (utilization >= 70) return "attention";
  return "healthy";
};

const levelLabel = (level: QuotaLevel, t: Translate) => {
  if (level === "healthy") return t("quotaHealthy");
  if (level === "attention") return t("quotaAttention");
  if (level === "tight") return t("quotaTight");
  if (level === "error") return t("quotaUnavailable");
  return t("quotaUnknown");
};

const quotaEvents = (quotas: AccountQuota[], t: Translate) => {
  const now = Date.now() / 1000;
  const events: QuotaEvent[] = [];
  for (const quota of quotas) {
    for (const window of quotaWindows(quota)) {
      if (window?.resetsAt && window.resetsAt > now) {
        events.push({
          accountId: quota.accountId,
          accountLabel: quota.label,
          at: window.resetsAt,
          detail: t("quotaWindowRecovers", {
            window: formatWindow(window.windowMinutes, t),
          }),
          kind: "reset",
        });
      }
    }
    for (const expiresAt of quota.resetCredits?.expiresAt ?? []) {
      if (expiresAt > now) {
        events.push({
          accountId: quota.accountId,
          accountLabel: quota.label,
          at: expiresAt,
          detail: t("resetCreditWillExpire"),
          kind: "expiry",
        });
      }
    }
  }
  return events.sort((left, right) => left.at - right.at);
};

const formatPlan = (planType: string | null) => {
  if (!planType) return null;
  return planType
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

const formatCount = (value: number | null, locale: Locale) =>
  value === null
    ? "—"
    : new Intl.NumberFormat(locale, { notation: "compact" }).format(value);

const formatDuration = (seconds: number | null, t: Translate) => {
  if (seconds === null) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.max(1, Math.round((seconds % 3600) / 60));
  if (!hours) return t("minutesCount", { count: minutes });
  return t("hoursMinutes", { hours, minutes });
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

function QuotaSummary({
  detail,
  label,
  tone,
  value,
}: {
  detail: string;
  label: string;
  tone?: "accent" | "warning";
  value: string;
}) {
  return (
    <article className={`quota-summary${tone ? ` ${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function QuotaSkeleton({ label }: { label: string }) {
  return (
    <div className="quota-skeleton" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      <div className="quota-summary-grid" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <article className="quota-summary" key={index}>
            <span className="usage-skeleton-block skeleton-metric-label" />
            <span className="usage-skeleton-block skeleton-quota-summary" />
            <span className="usage-skeleton-block skeleton-subheading" />
          </article>
        ))}
      </div>
      <div className="quota-dashboard-grid" aria-hidden="true">
        <div className="quota-account-list">
          {Array.from({ length: 2 }, (_, index) => (
            <article className="quota-card usage-skeleton-quota" key={index}>
              <span className="usage-skeleton-block skeleton-heading" />
              <span className="usage-skeleton-block skeleton-subheading" />
              <span className="usage-skeleton-block skeleton-track" />
              <span className="usage-skeleton-block skeleton-track" />
            </article>
          ))}
        </div>
        <article className="quota-timeline-card">
          <span className="usage-skeleton-block skeleton-heading" />
          {Array.from({ length: 4 }, (_, index) => (
            <span
              className="usage-skeleton-block quota-event-skeleton"
              key={index}
            />
          ))}
        </article>
      </div>
    </div>
  );
}

export function QuotaPanel({
  activeAccountId,
  error,
  loading,
  locale,
  onRefresh,
  privateMode,
  quotas,
  t,
}: QuotaPanelProps) {
  const displayLabel = (label: string) =>
    privateMode ? redactEmails(label, t("emailHidden")) : label;
  const events = quotaEvents(quotas ?? [], t);
  const successful = quotas?.filter((quota) => quota.success) ?? [];
  const totalCredits = successful.reduce(
    (total, quota) => total + (quota.resetCredits?.availableCount ?? 0),
    0,
  );
  const bestQuota = successful
    .filter((quota) => quotaUtilization(quota) !== null)
    .sort(
      (left, right) =>
        (quotaUtilization(left) ?? 100) - (quotaUtilization(right) ?? 100),
    )[0];
  const nextReset = events.find((event) => event.kind === "reset");
  const nextExpiry = events.find((event) => event.kind === "expiry");
  const activeQuota = successful.find(
    (quota) => quota.accountId === activeAccountId,
  );
  const sceneQuota = activeQuota ?? bestQuota;
  const sceneUtilization = sceneQuota ? quotaUtilization(sceneQuota) : null;
  const sceneLevel =
    sceneUtilization === null
      ? "unknown"
      : sceneUtilization >= 90
        ? "tight"
        : sceneUtilization >= 70
          ? "attention"
          : "healthy";
  const sceneAccountLabel = sceneQuota
    ? displayLabel(sceneQuota.label)
    : t("quotaSceneNoAccount");
  const sceneRecoveryLabel = nextReset
    ? formatRelative(nextReset.at, locale)
    : t("noneSoon");
  const sortedQuotas = [...(quotas ?? [])].sort((left, right) => {
    if (left.accountId === activeAccountId) return -1;
    if (right.accountId === activeAccountId) return 1;
    if (left.success !== right.success) return left.success ? -1 : 1;
    return (quotaUtilization(left) ?? 101) - (quotaUtilization(right) ?? 101);
  });

  return (
    <section className="quota-section">
      <div className="section-heading usage-heading">
        <div>
          <span className="eyebrow">{t("quotaOverview")}</span>
          <h2>{t("quotaTitle")}</h2>
          <p>{t("quotaDescription")}</p>
        </div>
        <button className="text-button" disabled={loading} onClick={onRefresh}>
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

      {!quotas && loading ? (
        <QuotaSkeleton label={t("quotaLoading")} />
      ) : !quotas ? (
        <div className="usage-empty-state">
          <strong>{t("quotaNotLoaded")}</strong>
          <p>{t("quotaNotLoadedHint")}</p>
          <button type="button" className="button primary" onClick={onRefresh}>
            {t("loadQuota")}
          </button>
        </div>
      ) : quotas.length ? (
        <div className="quota-loaded-content">
          <QuotaScene
            accountLabel={sceneAccountLabel}
            credits={totalCredits}
            level={sceneLevel}
            loading={loading}
            recoveryLabel={sceneRecoveryLabel}
            t={t}
            utilization={sceneUtilization}
          />

          <div className="quota-summary-grid">
            <QuotaSummary
              label={t("queryableAccounts")}
              value={`${successful.length}/${quotas.length}`}
              detail={t("queryableAccountsHint")}
            />
            <QuotaSummary
              label={t("mostAvailableAccount")}
              value={bestQuota ? displayLabel(bestQuota.label) : "—"}
              detail={
                bestQuota
                  ? t("highestWindowUsed", {
                      percent: Math.round(quotaUtilization(bestQuota) ?? 0),
                    })
                  : t("quotaUnavailable")
              }
              tone="accent"
            />
            <QuotaSummary
              label={t("nextQuotaRecovery")}
              value={
                nextReset ? formatRelative(nextReset.at, locale) : t("noneSoon")
              }
              detail={
                nextReset
                  ? `${displayLabel(nextReset.accountLabel)} · ${formatDate(nextReset.at, locale)}`
                  : t("noResetSchedule")
              }
            />
            <QuotaSummary
              label={t("availableResetCredits")}
              value={t("resetCreditCount", { count: totalCredits })}
              detail={
                nextExpiry
                  ? t("earliestCreditExpiry", {
                      date: formatDate(nextExpiry.at, locale, true),
                    })
                  : t("noCreditExpiry")
              }
              tone={nextExpiry ? "warning" : undefined}
            />
          </div>

          <div className="quota-dashboard-grid">
            <div className="quota-account-column">
              <div className="quota-panel-heading">
                <div>
                  <strong>{t("accountQuotaStatus")}</strong>
                  <span>{t("accountQuotaStatusHint")}</span>
                </div>
              </div>
              <div className="quota-account-list">
                {sortedQuotas.map((quota) => {
                  const level = quotaLevel(quota);
                  const buckets = quotaBuckets(quota);
                  const plan = formatPlan(quota.planType);
                  return (
                    <article
                      className={`quota-card level-${level}`}
                      key={quota.profileId}
                    >
                      <div className="quota-account quota-account-status">
                        <div>
                          <strong>{displayLabel(quota.label)}</strong>
                          <span>
                            {quota.accountId === activeAccountId
                              ? t("currentAccount")
                              : t("savedAccount")}
                          </span>
                        </div>
                        <b className={`quota-status level-${level}`}>
                          {levelLabel(level, t)}
                        </b>
                      </div>

                      {quota.success ? (
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
                          </div>
                          {quota.resetCredits && (
                            <div className="reset-credits">
                              <div>
                                <span>{t("availableResetCredits")}</span>
                                <strong>
                                  {t("resetCreditCount", {
                                    count: quota.resetCredits.availableCount,
                                  })}
                                </strong>
                              </div>
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
                          {quota.officialUsage && (
                            <div className="quota-official-usage">
                              <div className="quota-subsection-heading">
                                <strong>{t("officialAccountUsage")}</strong>
                                <span>{t("officialAccountUsageHint")}</span>
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
                                    {quota.officialUsage.currentStreakDays ===
                                    null
                                      ? "—"
                                      : t("daysCount", {
                                          count:
                                            quota.officialUsage
                                              .currentStreakDays,
                                        })}
                                    {quota.officialUsage.longestStreakDays !==
                                      null && (
                                      <small>
                                        {t("longestStreak", {
                                          count:
                                            quota.officialUsage
                                              .longestStreakDays,
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
                          )}
                          <div className="quota-windows">
                            {buckets.map((bucket) => (
                              <div className="quota-bucket" key={bucket.id}>
                                <div className="quota-bucket-heading">
                                  <strong>
                                    {bucket.name ?? t("defaultCodexQuota")}
                                  </strong>
                                  {bucket.name && (
                                    <span>{t("modelSpecificQuota")}</span>
                                  )}
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
                              <p className="quota-empty">
                                {t("noQuotaWindows")}
                              </p>
                            )}
                          </div>
                        </>
                      ) : (
                        <p className="quota-error">
                          {quota.error
                            ? localizeBackendError(quota.error, locale)
                            : t("quotaQueryFailed")}
                        </p>
                      )}
                      <small className="quota-queried-at">
                        {t("quotaQueriedAt", {
                          date: formatDate(quota.queriedAt, locale),
                        })}
                      </small>
                    </article>
                  );
                })}
              </div>
            </div>

            <article className="quota-timeline-card">
              <div className="quota-panel-heading">
                <div>
                  <strong>{t("quotaTimeline")}</strong>
                  <span>{t("quotaTimelineHint")}</span>
                </div>
              </div>
              {events.length ? (
                <ol className="quota-timeline">
                  {events.slice(0, 8).map((event, index) => (
                    <li
                      className={`${event.kind}${index === 0 ? " is-next" : ""}`}
                      key={`${event.accountId}-${event.kind}-${event.at}-${index}`}
                    >
                      <i aria-hidden="true" />
                      {index === 0 && (
                        <span className="quota-timeline-paw" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                          <b />
                        </span>
                      )}
                      <div>
                        <time
                          dateTime={new Date(event.at * 1000).toISOString()}
                        >
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
            </article>
          </div>

          <p className="usage-privacy-note">{t("quotaPrivacy")}</p>
        </div>
      ) : (
        <div className="quota-empty standalone">{t("saveForQuota")}</div>
      )}
    </section>
  );
}
