import { LocalUsageStats, ModelProviderState, TokenBreakdown } from "./api";
import { Locale, Translate } from "./i18n";
import { redactEmails } from "./privacy";

type UsagePanelProps = {
  usage: LocalUsageStats | null;
  loading: boolean;
  error: string | null;
  locale: Locale;
  onRefresh: () => void;
  privateMode: boolean;
  t: Translate;
  modelProvider: ModelProviderState | null;
};

const SKELETON_TREND_BARS = Array.from({ length: 14 });

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

function UsageSkeleton({ label }: { label: string }) {
  return (
    <div className="usage-skeleton" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      <div className="usage-skeleton-visual" aria-hidden="true">
        <div className="usage-metrics">
          {Array.from({ length: 3 }, (_, index) => (
            <article
              className={`usage-metric usage-skeleton-metric${index === 0 ? " emphasis" : ""}`}
              key={index}
            >
              <span className="usage-skeleton-block skeleton-metric-label" />
              <span className="usage-skeleton-block skeleton-metric-value" />
              <span className="usage-skeleton-block skeleton-metric-unit" />
            </article>
          ))}
        </div>

        <div className="usage-insights">
          <article className="trend-card usage-skeleton-panel">
            <div className="usage-skeleton-card-heading">
              <div>
                <span className="usage-skeleton-block skeleton-heading" />
                <span className="usage-skeleton-block skeleton-subheading" />
              </div>
              <span className="usage-skeleton-block skeleton-meta" />
            </div>
            <div className="usage-skeleton-chart">
              {SKELETON_TREND_BARS.map((_, index) => (
                <span className="usage-skeleton-block" key={index} />
              ))}
            </div>
          </article>

          <article className="breakdown-card usage-skeleton-panel">
            <span className="usage-skeleton-block skeleton-heading" />
            <span className="usage-skeleton-block skeleton-subheading" />
            <div className="usage-skeleton-breakdown">
              {Array.from({ length: 4 }, (_, index) => (
                <span className="usage-skeleton-block" key={index} />
              ))}
            </div>
          </article>
        </div>

        <div className="local-attribution-heading usage-skeleton-quota-heading">
          <div>
            <span className="usage-skeleton-block skeleton-heading" />
            <span className="usage-skeleton-block skeleton-subheading" />
          </div>
        </div>
        <div className="local-attribution-list">
          {Array.from({ length: 3 }, (_, index) => (
            <span
              className="usage-skeleton-block local-attribution-skeleton"
              key={index}
            />
          ))}
        </div>
        <span className="usage-skeleton-block skeleton-privacy" />
      </div>
    </div>
  );
}

export function UsagePanel({
  usage,
  loading,
  error,
  locale,
  onRefresh,
  privateMode,
  t,
  modelProvider,
}: UsagePanelProps) {
  const compactNumber = new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const fullNumber = new Intl.NumberFormat(locale);
  const maxDaily = Math.max(
    1,
    ...(usage?.daily.map((day) => day.tokens.totalTokens) ?? []),
  );
  const breakdown = usage?.thirtyDays;

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

      {loading && !usage ? (
        <UsageSkeleton label={t("usageLoading")} />
      ) : !usage ? (
        <div className="usage-empty-state">
          <strong>{t("usageNotLoaded")}</strong>
          <p>{t("usageNotLoadedHint")}</p>
          <button type="button" className="button primary" onClick={onRefresh}>
            {t("loadUsage")}
          </button>
        </div>
      ) : usage ? (
        <div className="usage-loaded-content">
          <div className="usage-metrics">
            <MetricCard
              label={t("today")}
              tokens={usage.today}
              compactNumber={compactNumber}
              fullNumber={fullNumber}
              emphasis
            />
            <MetricCard
              label={t("last7Days")}
              tokens={usage.sevenDays}
              compactNumber={compactNumber}
              fullNumber={fullNumber}
            />
            <MetricCard
              label={t("last30Days")}
              tokens={usage.thirtyDays}
              compactNumber={compactNumber}
              fullNumber={fullNumber}
            />
          </div>

          <div className="usage-insights">
            <article className="trend-card">
              <div className="usage-card-title">
                <div>
                  <strong>{t("trend14Days")}</strong>
                  <span>{t("usageEvents", { count: usage.eventsCount })}</span>
                </div>
                <small>
                  {t("sessionFiles", { count: usage.filesScanned })}
                </small>
              </div>
              <div className="trend-bars" aria-label={t("trendAria")}>
                {usage.daily.map((day) => (
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

          <div className="local-attribution-heading">
            <div>
              <strong>{t("modelProviderAttribution")}</strong>
              <span>{t("modelProviderAttributionHint")}</span>
            </div>
            {!privateMode && modelProvider?.activeProvider && (
              <small>
                {t("modelProviderCurrent", {
                  provider: modelProvider.activeProvider,
                })}
              </small>
            )}
          </div>
          {usage.byProvider && usage.byProvider.length ? (
            <div className="local-attribution-list">
              {usage.byProvider.map((provider, index) => {
                const share =
                  usage.thirtyDays.totalTokens > 0
                    ? (provider.tokens.totalTokens /
                        usage.thirtyDays.totalTokens) *
                      100
                    : 0;
                const privateProviderIndex = usage
                  .byProvider!.slice(0, index + 1)
                  .filter((item) => item.kind === "thirdParty").length;
                const label =
                  privateMode && provider.kind === "thirdParty"
                    ? t("modelProviderPrivate", {
                        index: privateProviderIndex,
                      })
                    : provider.kind === "openai"
                      ? t("modelProviderOpenai")
                      : provider.kind === "unattributed"
                        ? t("modelProviderUnattributed")
                        : provider.label;
                const quotaHint =
                  provider.kind === "unattributed"
                    ? t("modelProviderUnattributedHint")
                    : t("modelProviderQuotaUnknown");
                return (
                  <article
                    className={`local-attribution-row provider-${provider.kind}`}
                    key={provider.id}
                  >
                    <div>
                      <strong>{label}</strong>
                      <span>{quotaHint}</span>
                      {!privateMode && provider.host && (
                        <small className="model-provider-host">
                          {provider.host}
                        </small>
                      )}
                    </div>
                    <div className="local-attribution-value">
                      <b
                        title={`${fullNumber.format(provider.tokens.totalTokens)} tokens`}
                      >
                        {compactNumber.format(provider.tokens.totalTokens)}
                      </b>
                      <small>
                        {t("usageShare", { percent: Math.round(share) })}
                      </small>
                    </div>
                    <span
                      className="local-attribution-track"
                      aria-hidden="true"
                    >
                      <i style={{ width: `${Math.min(100, share)}%` }} />
                    </span>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="quota-empty standalone">{t("noLocalUsage")}</div>
          )}
          <small className="model-provider-note">
            {t("modelProviderHint")}
          </small>

          <div className="local-attribution-heading">
            <div>
              <strong>{t("accountAttribution")}</strong>
              <span>{t("accountAttributionHint")}</span>
            </div>
            {usage.unassigned.totalTokens > 0 && (
              <small
                title={`${fullNumber.format(usage.unassigned.totalTokens)} tokens`}
              >
                {t("unassignedHistory", {
                  tokens: compactNumber.format(usage.unassigned.totalTokens),
                })}
              </small>
            )}
          </div>
          {usage.byAccount.length ? (
            <div className="local-attribution-list">
              {usage.byAccount.map((account) => {
                const share =
                  usage.thirtyDays.totalTokens > 0
                    ? (account.tokens.totalTokens /
                        usage.thirtyDays.totalTokens) *
                      100
                    : 0;
                return (
                  <article
                    className="local-attribution-row"
                    key={account.accountId}
                  >
                    <div>
                      <strong>
                        {privateMode
                          ? redactEmails(account.label, t("emailHidden"))
                          : account.label}
                      </strong>
                      <span>{t("localUsage30Days")}</span>
                    </div>
                    <div className="local-attribution-value">
                      <b
                        title={`${fullNumber.format(account.tokens.totalTokens)} tokens`}
                      >
                        {compactNumber.format(account.tokens.totalTokens)}
                      </b>
                      <small>
                        {t("usageShare", { percent: Math.round(share) })}
                      </small>
                    </div>
                    <span
                      className="local-attribution-track"
                      aria-hidden="true"
                    >
                      <i style={{ width: `${Math.min(100, share)}%` }} />
                    </span>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="quota-empty standalone">{t("noLocalUsage")}</div>
          )}

          <p className="usage-privacy-note">{t("usagePrivacy")}</p>
        </div>
      ) : null}
    </section>
  );
}
