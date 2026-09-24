import type { ModelPrice } from "./api";
import type { Locale, Translate } from "./i18n";
import { compareQuotaCosts } from "./quotaCost";
import type { CostComparison } from "./quotaCost";
import { formatCount } from "./quotaView";

type MoneyFormatter = (value: number | null | undefined) => string;

function Difference({
  difference,
  formatMoney,
  locale,
  t,
}: {
  difference: CostComparison["withCache"];
  formatMoney: MoneyFormatter;
  locale: Locale;
  t: Translate;
}) {
  if (!difference) return <span>{t("costComparisonUnavailable")}</span>;
  if (difference.amount === 0) return <span>{t("costComparisonEqual")}</span>;
  const cheaper = difference.amount < 0;
  const magnitude = Math.abs(difference.percent ?? 0);
  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return (
    <span className={cheaper ? "cost-difference-lower" : undefined}>
      {t(cheaper ? "costComparisonLess" : "costComparisonMore", {
        amount: formatMoney(Math.abs(difference.amount)),
      })}
      <small>
        {difference.percent === null
          ? t("costComparisonZeroBase")
          : t(
              cheaper
                ? "costComparisonLowerPercent"
                : "costComparisonHigherPercent",
              {
                percent:
                  magnitude > 0 && magnitude < 0.1
                    ? `< ${percent.format(0.1)}`
                    : percent.format(magnitude),
              },
            )}
      </small>
    </span>
  );
}

export function QuotaCostPeriod({
  title,
  usage,
  accountCount,
  referencePrice,
  comparisonPrice,
  inputPercent,
  cachePercent,
  formatMoney,
  locale,
  t,
}: {
  title: string;
  usage: { tokens: number | null; count: number };
  accountCount: number;
  referencePrice: ModelPrice | undefined;
  comparisonPrice: ModelPrice | undefined;
  inputPercent: number;
  cachePercent: number;
  formatMoney: MoneyFormatter;
  locale: Locale;
  t: Translate;
}) {
  const result = compareQuotaCosts(
    usage.tokens,
    inputPercent,
    referencePrice,
    comparisonPrice,
    cachePercent,
  );
  const estimate = result.reference;
  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const cacheLabel = t("costWithCache", {
    cache: percent.format(cachePercent),
  });
  const breakdown = [
    {
      label: "costUncachedInput",
      tokens: "uncachedInputTokens",
      cost: "uncachedInputCost",
    },
    {
      label: "costCachedInput",
      tokens: "cachedInputTokens",
      cost: "cachedInputCost",
    },
    { label: "costOutput", tokens: "outputTokens", cost: "outputCost" },
  ] as const;
  const tokenEstimate = estimate ?? result.comparison;
  return (
    <article className="cost-period">
      <div className="cost-period-overview">
        <h3>
          {title}
          <small>{formatCount(usage.tokens, locale)} tokens</small>
        </h3>
        <p className="cost-estimate-label">{t("costEstimatedApiCost")}</p>
        {comparisonPrice ? (
          <table className="cost-comparison-table">
            <caption className="visually-hidden">
              {t("costComparisonCaption", { period: title })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("costModelColumn")}</th>
                <th scope="col">{t("costCurrentEstimate")}</th>
              </tr>
            </thead>
            <tbody>
              {[
                {
                  key: "A",
                  model: referencePrice?.model ?? t("costChooseModel"),
                  value: estimate,
                },
                {
                  key: "B",
                  model: comparisonPrice.model,
                  value: result.comparison,
                },
              ].map(({ key, model, value }) => (
                <tr key={key}>
                  <th scope="row">
                    <span className="cost-model-badge">{key}</span>
                    {model}
                  </th>
                  <td className="cost-comparison-current">
                    {formatMoney(value?.withCache)}
                  </td>
                </tr>
              ))}
              <tr className="cost-difference-row">
                <th scope="row">{t("costComparisonDifference")}</th>
                <td>
                  <Difference
                    difference={result.withCache}
                    formatMoney={formatMoney}
                    locale={locale}
                    t={t}
                  />
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
          <>
            <strong className="cost-estimate-amount">
              {formatMoney(estimate?.withCache)}
            </strong>
            <p className="cost-estimate-model">
              {referencePrice?.model ?? t("costChooseModel")}
            </p>
          </>
        )}
        <p className="cost-note">{cacheLabel}</p>
      </div>
      <p className="cost-coverage">
        {t("quotaUsageCoverage", { count: usage.count, total: accountCount })}
      </p>
      {usage.tokens === null ? (
        <p className="cost-warning">{t("costNoQuotaUsage")}</p>
      ) : usage.count < accountCount ? (
        <p className="cost-warning">{t("costPartialAccounts")}</p>
      ) : null}
      {tokenEstimate && (
        <details className="cost-details cost-comparison-breakdown">
          <summary>{t("costResultDetails")}</summary>
          {comparisonPrice ? (
            <>
              <p className="cost-note">{t("costNoCacheGuide")}</p>
              <table className="cost-comparison-table">
                <caption className="visually-hidden">
                  {t("costResultDetails")} · {title}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t("costTokenComponent")}</th>
                    <th scope="col">A · {referencePrice?.model ?? "—"}</th>
                    <th scope="col">B · {comparisonPrice.model}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">{t("costNoCache")}</th>
                    <td>{formatMoney(estimate?.noCache)}</td>
                    <td>{formatMoney(result.comparison?.noCache)}</td>
                  </tr>
                  <tr className="cost-difference-row">
                    <th scope="row">{t("costNoCacheDifference")}</th>
                    <td colSpan={2}>
                      <Difference
                        difference={result.noCache}
                        formatMoney={formatMoney}
                        locale={locale}
                        t={t}
                      />
                    </td>
                  </tr>
                  {breakdown.map(({ label, tokens, cost }) => (
                    <tr key={label}>
                      <th scope="row">
                        {t(label)}
                        <small>
                          {formatCount(tokenEstimate[tokens], locale)} tokens
                        </small>
                      </th>
                      <td>{formatMoney(estimate?.[cost])}</td>
                      <td>{formatMoney(result.comparison?.[cost])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            estimate && (
              <div className="cost-breakdown">
                <dl>
                  <div>
                    <dt>{t("costNoCacheGuide")}</dt>
                    <dd>{formatMoney(estimate.noCache)}</dd>
                  </div>
                </dl>
                <p>{t("costBreakdownTitle")}</p>
                <dl>
                  {breakdown.map(({ label, tokens, cost }) => (
                    <div key={label}>
                      <dt>
                        {t(label)}
                        <small>
                          {formatCount(estimate[tokens], locale)} tokens
                        </small>
                      </dt>
                      <dd>{formatMoney(estimate[cost])}</dd>
                    </div>
                  ))}
                </dl>
                {estimate.withCache !== null && estimate.withCache > 0 && (
                  <p className="cost-output-share">
                    {t("costOutputShare", {
                      share: percent.format(
                        (100 * estimate.outputCost) / estimate.withCache,
                      ),
                    })}
                  </p>
                )}
              </div>
            )
          )}
        </details>
      )}
    </article>
  );
}
