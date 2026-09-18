import { useEffect, useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getModelPrices } from "./api";
import type { AccountQuota, AccountSummary, ModelPrices } from "./api";
import type { Locale, Translate } from "./i18n";
import { estimateQuotaCost } from "./quotaCost";
import { formatCount, summarizeQuotas } from "./quotaView";

const periods = ["sevenDays", "thirtyDays"] as const;
const periodKeys = {
  sevenDays: "last7Days",
  thirtyDays: "last30Days",
} as const;

export function QuotaCostPanel({
  accounts,
  quotas,
  refreshErrors,
  displayLabel,
  locale,
  t,
}: {
  accounts: AccountSummary[];
  quotas: AccountQuota[];
  refreshErrors: Record<string, string>;
  displayLabel: (label: string) => string;
  locale: Locale;
  t: Translate;
}) {
  const id = useId();
  const [pricing, setPricing] = useState<ModelPrices | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false);
  const [profileId, setProfileId] = useState("");
  const [model, setModel] = useState("");
  const [inputPercent, setInputPercent] = useState(80);
  const selectedId = accounts.some((account) => account.id === profileId)
    ? profileId
    : "";
  const selectedQuotas = selectedId
    ? quotas.filter((quota) => quota.profileId === selectedId)
    : quotas;
  const summary = summarizeQuotas(selectedQuotas);
  const accountCount = selectedId
    ? 1
    : new Set(accounts.map((account) => account.accountId)).size;
  const stale = selectedQuotas.some(
    (quota) => quota.success && refreshErrors[quota.profileId],
  );
  const prices = pricing?.prices ?? [];
  const selectedPrice = prices.find((price) => price.model === model);

  useEffect(() => {
    let cancelled = false;
    void getModelPrices()
      .then((value) => {
        if (!cancelled) setPricing(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    if (loading) return;
    setLoading(true);
    setFailed(false);
    try {
      setPricing(await getModelPrices(true));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  const money = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "code",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const rate = new Intl.NumberFormat(locale, { maximumFractionDigits: 4 });
  const formatMoney = (value: number | null | undefined) =>
    value == null
      ? "—"
      : value > 0 && value < 0.01
        ? `< ${money.format(0.01)}`
        : money.format(value);

  return (
    <details className="quota-cost-panel" aria-labelledby={`${id}-title`}>
      <summary className="cost-summary">
        <ChevronDown size={16} aria-hidden="true" />
        <div>
          <strong id={`${id}-title`}>{t("costTitle")}</strong>
          <span>{t("costSubtitle")}</span>
        </div>
      </summary>
      <div className="cost-body" aria-busy={loading}>
        <div className="cost-actions">
          <button
            type="button"
            className="text-button"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? t("costLoading") : t("costRefresh")}
          </button>
        </div>
        <p className="cost-note">{t("costAssumptionsHint")}</p>
        <div className="cost-controls">
          <label>
            <span>{t("costAccountScope")}</span>
            <select
              value={selectedId}
              onChange={(event) => setProfileId(event.target.value)}
            >
              <option value="">{t("quotaActivityAllAccounts")}</option>
              {accounts.map((account) => (
                <option value={account.id} key={account.id}>
                  {displayLabel(account.label)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("costReferenceModel")}</span>
            <select
              value={selectedPrice ? model : ""}
              disabled={!prices.length}
              onChange={(event) => setModel(event.target.value)}
            >
              <option value="">{t("costChooseModel")}</option>
              {[...prices]
                .sort((a, b) => a.model.localeCompare(b.model))
                .map((price) => (
                  <option value={price.model} key={price.model}>
                    {price.model}
                  </option>
                ))}
            </select>
          </label>
          <label className="cost-ratio-control">
            <span>
              {t("costInputRatio", {
                input: inputPercent,
                output: 100 - inputPercent,
              })}
            </span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={inputPercent}
              onChange={(event) => setInputPercent(Number(event.target.value))}
              aria-valuetext={t("costInputRatio", {
                input: inputPercent,
                output: 100 - inputPercent,
              })}
            />
          </label>
        </div>

        {(failed || pricing?.warning) && (
          <p className="cost-warning" role="status">
            {t(
              failed
                ? "costLoadFailed"
                : pricing?.warning === "cacheWriteFailed"
                  ? "costCacheWriteFailed"
                  : "costRefreshFailed",
            )}
          </p>
        )}
        {stale && (
          <p className="cost-warning" role="status">
            {t("costStaleUsage")}
          </p>
        )}
        {!selectedPrice && (
          <p className="cost-note" role="status">
            {t("costChooseModelHint")}
          </p>
        )}
        {selectedPrice?.cachedInput === null && (
          <p className="cost-warning">{t("costNoCacheRate")}</p>
        )}

        <div className="cost-periods" aria-live="polite">
          {periods.map((period) => {
            const usage = summary[period];
            const estimate = estimateQuotaCost(
              usage.tokens,
              inputPercent,
              selectedPrice,
            );
            return (
              <article className="cost-period" key={period}>
                <h3>
                  {t(periodKeys[period])}
                  <small>{formatCount(usage.tokens, locale)} tokens</small>
                </h3>
                <dl>
                  <div>
                    <dt>{t("costNoCache")}</dt>
                    <dd>{formatMoney(estimate?.noCache)}</dd>
                  </div>
                  <div className="cost-cache-scenario">
                    <dt>{t("costCache90")}</dt>
                    <dd>{formatMoney(estimate?.cache90)}</dd>
                  </div>
                </dl>
                <p className="cost-coverage">
                  {t("quotaUsageCoverage", {
                    count: usage.count,
                    total: accountCount,
                  })}
                </p>
                {usage.tokens === null ? (
                  <p className="cost-warning">{t("costNoQuotaUsage")}</p>
                ) : usage.count < accountCount ? (
                  <p className="cost-warning">{t("costPartialAccounts")}</p>
                ) : null}
              </article>
            );
          })}
        </div>
        <p className="cost-note">{t("costDisclaimer")}</p>
        {pricing && (
          <div className="cost-source">
            <a
              className="text-button"
              href="https://developers.openai.com/api/docs/pricing"
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                if (!("__TAURI_INTERNALS__" in window)) return;
                event.preventDefault();
                setLinkFailed(false);
                void openUrl(
                  "https://developers.openai.com/api/docs/pricing",
                ).catch(() => setLinkFailed(true));
              }}
            >
              {t("costSource")}
            </a>
            <span>
              {t(
                pricing.source === "bundled"
                  ? "costBundledDate"
                  : "costUpdatedDate",
                {
                  date: new Date(pricing.updatedAt * 1000).toLocaleString(
                    locale,
                  ),
                },
              )}
            </span>
          </div>
        )}
        {linkFailed && (
          <p className="cost-warning" role="status">
            {t("costLinkFailed")}
          </p>
        )}
        <details className="cost-details">
          <summary>{t("costDetails")}</summary>
          <p className="cost-note">{t("costScenariosHint")}</p>
          {selectedPrice && (
            <p className="cost-note">
              {t("costSelectedRates", {
                model: selectedPrice.model,
                input: rate.format(selectedPrice.input),
                cached:
                  selectedPrice.cachedInput === null
                    ? "—"
                    : rate.format(selectedPrice.cachedInput),
                output: rate.format(selectedPrice.output),
              })}
            </p>
          )}
          <p className="cost-note">{t("costRatesHint")}</p>
        </details>
      </div>
    </details>
  );
}
