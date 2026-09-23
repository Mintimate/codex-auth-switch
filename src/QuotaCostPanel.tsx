import { useEffect, useId, useState } from "react";
import { isPublicDemo } from "./runtime";
import { ArrowLeftRight, Check, ChevronDown, RefreshCw } from "lucide-react";
import { ExternalLink } from "./ExternalLink";
import { getModelPrices } from "./api";
import type { AccountQuota, AccountSummary, ModelPrices } from "./api";
import type { Locale, Translate } from "./i18n";
import { QuotaCostPeriod } from "./QuotaCostPeriod";
import { summarizeQuotas } from "./quotaView";

const periods = ["sevenDays", "thirtyDays"] as const;
const periodKeys = {
  sevenDays: "last7Days",
  thirtyDays: "last30Days",
} as const;

// 便于比较费用的假设起点，不是任务类型的实测平均值。
const taskPresets = [
  {
    label: "costPresetCoding",
    hint: "costPresetCodingHint",
    input: 99,
    cache: 90,
  },
  {
    label: "costPresetGeneral",
    hint: "costPresetGeneralHint",
    input: 90,
    cache: 50,
  },
  {
    label: "costPresetFresh",
    hint: "costPresetFreshHint",
    input: 80,
    cache: 0,
  },
] as const;

function RatioControl({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="cost-ratio-control">
      <label htmlFor={id}>{label}</label>
      <div className="cost-ratio-inputs">
        <input
          id={id}
          type="range"
          min="0"
          max="100"
          step="0.1"
          value={value}
          onChange={(event) => {
            setDraft(null);
            onChange(Number(event.target.value));
          }}
          aria-valuetext={label}
        />
        <span className="cost-percent-input">
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={draft ?? value}
            aria-label={label}
            onBlur={() => setDraft(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onChange={(event) => {
              setDraft(event.target.value);
              const next = event.target.valueAsNumber;
              if (Number.isFinite(next) && next >= 0 && next <= 100)
                onChange(Math.round(next * 10) / 10);
            }}
          />
          <span aria-hidden="true">%</span>
        </span>
      </div>
    </div>
  );
}

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
  const [comparisonModel, setComparisonModel] = useState("");
  const [inputPercent, setInputPercent] = useState<number>(
    taskPresets[0].input,
  );
  const [cachePercent, setCachePercent] = useState<number>(
    taskPresets[0].cache,
  );
  const selectedPreset = taskPresets.find(
    (preset) => preset.input === inputPercent && preset.cache === cachePercent,
  );
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
  const sortedPrices = [...prices].sort((a, b) =>
    a.model.localeCompare(b.model),
  );
  const selectedPrice = prices.find((price) => price.model === model);
  const comparisonPrice = prices.find(
    (price) => price.model === comparisonModel,
  );
  const activePrices = prices.filter(
    (price) => price === selectedPrice || price === comparisonPrice,
  );

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
  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const formatMoney = (value: number | null | undefined) =>
    value == null
      ? "—"
      : value > 0 && value < 0.01
        ? `< ${money.format(0.01)}`
        : money.format(value);

  return (
    <section className="quota-cost-panel" aria-label={t("costTitle")}>
      <div className="cost-body" aria-busy={loading}>
        <div className="cost-toolbar">
          <p className="cost-note">{t("costAssumptionsHint")}</p>
          <button
            type="button"
            className="text-button cost-refresh"
            disabled={isPublicDemo || loading}
            title={isPublicDemo ? t("demoDesktopOnly") : undefined}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {loading ? t("costLoading") : t("costRefresh")}
          </button>
        </div>
        <div className="cost-controls">
          <div className="cost-selectors">
            <div className="cost-field">
              <label htmlFor={`${id}-account`}>{t("costAccountScope")}</label>
              <div className="cost-select">
                <select
                  id={`${id}-account`}
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
                <ChevronDown size={16} aria-hidden="true" />
              </div>
            </div>
            {(
              [
                {
                  key: "model",
                  label: "costReferenceModel",
                  value: selectedPrice?.model ?? "",
                  empty: "costChooseModel",
                  onChange: setModel,
                },
                {
                  key: "comparison",
                  label: "costComparisonModel",
                  value: comparisonPrice?.model ?? "",
                  empty: "costNoComparison",
                  onChange: setComparisonModel,
                },
              ] as const
            ).map((field) => (
              <div className="cost-field" key={field.key}>
                <label htmlFor={`${id}-${field.key}`}>{t(field.label)}</label>
                <div className="cost-select">
                  <select
                    id={`${id}-${field.key}`}
                    value={field.value}
                    disabled={!prices.length}
                    onChange={(event) => field.onChange(event.target.value)}
                  >
                    <option value="">{t(field.empty)}</option>
                    {sortedPrices.map((price) => (
                      <option value={price.model} key={price.model}>
                        {price.model}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={16} aria-hidden="true" />
                </div>
              </div>
            ))}
          </div>
          <div className="cost-comparison-guide">
            <p className="cost-note">{t("costComparisonHint")}</p>
            <button
              type="button"
              className="text-button cost-swap"
              disabled={!selectedPrice || !comparisonPrice}
              onClick={() => {
                setModel(comparisonModel);
                setComparisonModel(model);
              }}
            >
              <ArrowLeftRight size={14} aria-hidden="true" />
              {t("costSwapModels")}
            </button>
          </div>
          <fieldset className="cost-presets">
            <legend>{t("costTaskPresets")}</legend>
            <div className="cost-preset-options">
              {taskPresets.map((preset) => (
                <button
                  type="button"
                  className="cost-preset"
                  key={preset.label}
                  aria-pressed={selectedPreset === preset}
                  onClick={() => {
                    setInputPercent(preset.input);
                    setCachePercent(preset.cache);
                  }}
                >
                  <span className="cost-preset-title">
                    <strong>{t(preset.label)}</strong>
                    <Check size={16} aria-hidden="true" />
                  </span>
                  <span>
                    {t("costPresetRatios", {
                      input: preset.input,
                      cache: preset.cache,
                    })}
                  </span>
                </button>
              ))}
            </div>
            <p className="cost-note">{t("costPresetDisclaimer")}</p>
            <p className="cost-preset-hint" aria-live="polite">
              {t(selectedPreset?.hint ?? "costPresetCustomHint")}
            </p>
          </fieldset>
          <RatioControl
            id={`${id}-input`}
            label={t("costInputRatio", {
              input: percent.format(inputPercent),
              output: percent.format(100 - inputPercent),
            })}
            value={inputPercent}
            onChange={setInputPercent}
          />
          <RatioControl
            id={`${id}-cache`}
            label={t("costCacheRatio", { cache: percent.format(cachePercent) })}
            value={cachePercent}
            onChange={setCachePercent}
          />
        </div>
        <p className="cost-note">{t("costCacheRatioHint")}</p>

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
        {activePrices
          .filter((price) => price.cachedInput === null)
          .map((price) =>
            cachePercent > 0 &&
            inputPercent > 0 &&
            periods.some((period) => (summary[period].tokens ?? 0) > 0) ? (
              <p className="cost-warning" key={price.model}>
                {price.model} · {t("costNoCacheRate")}
              </p>
            ) : null,
          )}

        <div className="cost-periods" aria-live="polite">
          {periods.map((period) => (
            <QuotaCostPeriod
              key={period}
              title={t(periodKeys[period])}
              usage={summary[period]}
              accountCount={accountCount}
              referencePrice={selectedPrice}
              comparisonPrice={comparisonPrice}
              inputPercent={inputPercent}
              cachePercent={cachePercent}
              formatMoney={formatMoney}
              locale={locale}
              t={t}
            />
          ))}
        </div>
        <p className="cost-note">{t("costDisclaimer")}</p>
        {pricing && (
          <div className="cost-source">
            <ExternalLink
              className="text-button"
              href="https://developers.openai.com/api/docs/pricing"
              onOpen={() => setLinkFailed(false)}
              onOpenError={() => setLinkFailed(true)}
            >
              {t("costSource")}
            </ExternalLink>
            <ExternalLink
              className="text-button"
              href="https://developers.openai.com/api/docs/guides/prompt-caching#multi-turn-agent"
              onOpen={() => setLinkFailed(false)}
              onOpenError={() => setLinkFailed(true)}
            >
              {t("costCacheSource")}
            </ExternalLink>
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
          {activePrices.map((price) => (
            <p className="cost-note" key={price.model}>
              {t("costSelectedRates", {
                model: price.model,
                input: rate.format(price.input),
                cached:
                  price.cachedInput === null
                    ? "—"
                    : rate.format(price.cachedInput),
                output: rate.format(price.output),
              })}
            </p>
          ))}
          <p className="cost-note">{t("costRatesHint")}</p>
        </details>
      </div>
    </section>
  );
}
