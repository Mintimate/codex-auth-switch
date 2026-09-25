import { useEffect, useId, useState } from "react";
import { isPublicDemo } from "./runtime";
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  Info,
  RefreshCw,
} from "lucide-react";
import { ExternalLink } from "./ExternalLink";
import { getModelPrices } from "./api";
import type { AccountQuota, AccountSummary, ModelPrices } from "./api";
import type { Locale, Translate } from "./i18n";
import { QuotaCostPeriod } from "./QuotaCostPeriod";
import { GuideSpotlight } from "./PageGuide";
import { summarizeQuotas } from "./quotaView";

const periods = ["sevenDays", "thirtyDays"] as const;
const periodKeys = {
  sevenDays: "last7Days",
  thirtyDays: "last30Days",
} as const;

const tourSteps = [
  {
    target: '[data-cost-tour="account"]',
    title: "costTourAccountTitle",
    description: "costTourAccountBody",
  },
  {
    target: '[data-cost-tour="model"]',
    title: "costTourModelTitle",
    description: "costTourModelBody",
  },
  {
    target: '[data-cost-tour="presets"]',
    title: "costTourPresetTitle",
    description: "costTourPresetBody",
  },
  {
    target: '[data-cost-tour="result"] > :first-child .cost-period-overview',
    title: "costTourResultTitle",
    description: "costTourResultBody",
  },
] as const;

// 便于比较费用的假设起点，不是任务类型的实测平均值。
const taskPresets = [
  {
    label: "costPresetCoding",
    hint: "costPresetCodingHint",
    description: "costPresetCodingDescription",
    input: 99,
    cache: 90,
  },
  {
    label: "costPresetGeneral",
    hint: "costPresetGeneralHint",
    description: "costPresetGeneralDescription",
    input: 90,
    cache: 50,
  },
  {
    label: "costPresetFresh",
    hint: "costPresetFreshHint",
    description: "costPresetFreshDescription",
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
  usageLoading,
  onRefreshUsage,
  guideOpen,
  onCloseGuide,
  displayLabel,
  locale,
  t,
}: {
  accounts: AccountSummary[];
  quotas: AccountQuota[];
  refreshErrors: Record<string, string>;
  usageLoading: boolean;
  onRefreshUsage: () => void;
  guideOpen: boolean;
  onCloseGuide: () => void;
  displayLabel: (label: string) => string;
  locale: Locale;
  t: Translate;
}) {
  const id = useId();
  const [tourStep, setTourStep] = useState(0);
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
  const hasUsage = periods.some((period) => summary[period].tokens !== null);
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
    if (guideOpen) setTourStep(0);
  }, [guideOpen]);

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
      <div className="cost-controls cost-main-controls">
        <div className="cost-selectors">
          <div className="cost-field" data-cost-tour="account">
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
          <div className="cost-field" data-cost-tour="model">
            <label htmlFor={`${id}-model`}>{t("costReferenceModel")}</label>
            <div className="cost-select">
              <select
                id={`${id}-model`}
                value={selectedPrice?.model ?? ""}
                disabled={!prices.length}
                onChange={(event) => {
                  setModel(event.target.value);
                  if (guideOpen && tourStep === 1 && event.target.value)
                    setTourStep(2);
                }}
              >
                <option value="">
                  {t(
                    loading && !prices.length
                      ? "costLoading"
                      : "costChooseModel",
                  )}
                </option>
                {sortedPrices.map((price) => (
                  <option value={price.model} key={price.model}>
                    {price.model}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} aria-hidden="true" />
            </div>
          </div>

          <div className="cost-field" data-cost-tour="comparison">
            <label htmlFor={`${id}-comparison`}>
              {t("costComparisonModel")}
            </label>
            <div className="cost-select">
              <select
                id={`${id}-comparison`}
                value={comparisonPrice?.model ?? ""}
                disabled={!prices.length}
                onChange={(event) => setComparisonModel(event.target.value)}
              >
                <option value="">{t("costChooseComparison")}</option>
                {sortedPrices.map((price) => (
                  <option value={price.model} key={price.model}>
                    {price.model}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} aria-hidden="true" />
            </div>
          </div>
        </div>
      </div>
      <div className="cost-comparison-guide">
        <p className="cost-note">{t("costModelGuide")}</p>
        {comparisonPrice && (
          <button
            type="button"
            className="text-button cost-swap"
            disabled={!selectedPrice}
            onClick={() => {
              setModel(comparisonModel);
              setComparisonModel(model);
            }}
          >
            <ArrowLeftRight size={14} aria-hidden="true" />
            {t("costSwapModels")}
          </button>
        )}
      </div>
      <fieldset className="cost-presets">
        <legend>{t("costTaskPresets")}</legend>
        <div className="cost-preset-options" data-cost-tour="presets">
          {taskPresets.map((preset) => (
            <button
              type="button"
              className="cost-preset"
              key={preset.label}
              aria-pressed={selectedPreset === preset}
              onClick={() => {
                setInputPercent(preset.input);
                setCachePercent(preset.cache);
                if (guideOpen && tourStep === 2) setTourStep(3);
              }}
            >
              <span className="cost-preset-title">
                <strong>{t(preset.label)}</strong>
                <Check size={16} aria-hidden="true" />
              </span>
              <span>{t(preset.description)}</span>
            </button>
          ))}
        </div>
        <p className="cost-note">{t("costPresetGuide")}</p>
        {!selectedPreset && (
          <p className="cost-note" role="status">
            {t("costPresetCustomHint")}
          </p>
        )}
      </fieldset>

      <details className="cost-details cost-advanced">
        <summary>{t("costAdvancedSettings")}</summary>
        <p className="cost-note">{t("costAdvancedGuide")}</p>
        <div className="cost-controls">
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
            label={t("costCacheRatio", {
              cache: percent.format(cachePercent),
            })}
            value={cachePercent}
            onChange={setCachePercent}
          />
        </div>
        <p className="cost-note">{t("costCacheRatioHint")}</p>
        <p className="cost-preset-hint">
          {t(selectedPreset?.hint ?? "costPresetCustomHint")}
        </p>
        <p className="cost-note">{t("costPresetDisclaimer")}</p>
      </details>
      {stale && (
        <p className="cost-warning" role="status">
          {t("costStaleUsage")}
        </p>
      )}
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
      {activePrices
        .filter((price) => price.cachedInput === null)
        .map((price) =>
          cachePercent > 0 &&
          inputPercent > 0 &&
          periods.some((period) => (summary[period].tokens ?? 0) > 0) ? (
            <div className="cost-warning" key={price.model} role="status">
              <p>
                {price.model} · {t("costNoCacheRate")}
              </p>
              <button
                type="button"
                className="text-button"
                onClick={() => setCachePercent(0)}
              >
                {t("costUseNoCache")}
              </button>
            </div>
          ) : null,
        )}

      <div className="cost-results" aria-busy={usageLoading}>
        <div className="cost-results-heading">
          <h3>{t("costResultsTitle")}</h3>
          <p className="cost-note">
            {t("costPresetRatios", {
              input: percent.format(inputPercent),
              cache: percent.format(cachePercent),
            })}
          </p>
        </div>
        {!hasUsage ? (
          <div
            className="cost-empty-state"
            data-cost-tour="result"
            role="status"
          >
            <strong>
              {t(usageLoading ? "costLoadingUsage" : "costUsageMissingTitle")}
            </strong>
            <p>{t("costNoQuotaUsage")}</p>
            <button
              type="button"
              className="button secondary"
              disabled={usageLoading}
              onClick={onRefreshUsage}
            >
              <RefreshCw size={15} aria-hidden="true" />
              {t(usageLoading ? "costLoadingUsage" : "costRefreshUsage")}
            </button>
          </div>
        ) : !selectedPrice ? (
          <div
            className="cost-empty-state"
            data-cost-tour="result"
            role="status"
          >
            <strong>{t("costModelRequired")}</strong>
            <p>{t("costLiveEstimateHint")}</p>
          </div>
        ) : (
          <div className="cost-periods" data-cost-tour="result">
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
        )}
      </div>
      <div className="cost-guide-note">
        <Info size={18} aria-hidden="true" />
        <p>{t("costResultGuide")}</p>
      </div>
      {comparisonPrice && (
        <p className="cost-note">{t("costComparisonHint")}</p>
      )}
      <details className="cost-details">
        <summary>{t("costDetails")}</summary>
        <p className="cost-note">{t("costUsagePeriodHint")}</p>
        <p className="cost-note">{t("costAssumptionsHint")}</p>
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
        <p className="cost-note">{t("costDisclaimer")}</p>
        <p className="cost-note">{t("costRatesHint")}</p>
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
        </div>
        {linkFailed && (
          <p className="cost-warning" role="status">
            {t("costLinkFailed")}
          </p>
        )}
      </details>
      <div className="cost-pricing-status">
        <span>
          {pricing
            ? t(
                pricing.source === "bundled"
                  ? "costBundledDate"
                  : "costUpdatedDate",
                {
                  date: new Date(pricing.updatedAt * 1000).toLocaleString(
                    locale,
                  ),
                },
              )
            : t(loading ? "costLoading" : "costPricesUnavailable")}
        </span>
        <button
          type="button"
          className="text-button cost-refresh"
          disabled={isPublicDemo || loading}
          title={isPublicDemo ? t("demoDesktopOnly") : undefined}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} aria-hidden="true" />
          {t(loading ? "costLoading" : "costRefresh")}
        </button>
      </div>
      {guideOpen && (
        <GuideSpotlight
          targetSelector={
            tourStep === 3 && (!hasUsage || !selectedPrice)
              ? '[data-cost-tour="result"]'
              : tourSteps[tourStep].target
          }
          step={tourStep}
          total={tourSteps.length}
          title={t(tourSteps[tourStep].title)}
          description={t(tourSteps[tourStep].description)}
          hint={
            (tourStep === 0 || tourStep === 3) && !hasUsage
              ? t("costUsageRequired")
              : tourStep === 1 && !selectedPrice
                ? t("costModelRequired")
                : undefined
          }
          nextDisabled={tourStep === 1 && !selectedPrice}
          action={
            (tourStep === 0 || tourStep === 3) && !hasUsage
              ? {
                  label: t(
                    usageLoading ? "costLoadingUsage" : "costRefreshUsage",
                  ),
                  onClick: onRefreshUsage,
                  disabled: usageLoading,
                }
              : tourStep === 1 && !prices.length
                ? {
                    label: t(loading ? "costLoading" : "costRefresh"),
                    onClick: () => void refresh(),
                    disabled: isPublicDemo || loading,
                  }
                : undefined
          }
          onNext={() =>
            tourStep === tourSteps.length - 1
              ? onCloseGuide()
              : setTourStep(tourStep + 1)
          }
          onPrevious={
            tourStep > 0 ? () => setTourStep(tourStep - 1) : undefined
          }
          onClose={onCloseGuide}
          t={t}
        />
      )}
    </section>
  );
}
