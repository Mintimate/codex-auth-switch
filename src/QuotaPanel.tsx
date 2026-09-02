import { AccountQuota } from "./api";
import { Locale, Translate } from "./i18n";
import { redactEmails } from "./privacy";
import { QuotaCard } from "./QuotaCard";
import { QuotaScene } from "./QuotaScene";
import {
  formatDate,
  formatRelative,
  quotaEvents,
  quotaUtilization,
} from "./quotaView";

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
                {sortedQuotas.map((quota) => (
                  <QuotaCard
                    activeAccountId={activeAccountId}
                    accountLabel={displayLabel(quota.label)}
                    key={quota.profileId}
                    locale={locale}
                    quota={quota}
                    t={t}
                  />
                ))}
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
