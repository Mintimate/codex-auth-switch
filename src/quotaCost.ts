import type { ModelPrice } from "./api";

// 账号每日用量只有总数。模型、输入和缓存占比均为假设，不能伪称实际用量拆分。
export function estimateQuotaCost(
  totalTokens: number | null,
  inputPercent: number,
  price: ModelPrice | undefined,
  cachePercent = 90,
) {
  if (
    totalTokens === null ||
    !Number.isFinite(totalTokens) ||
    totalTokens < 0 ||
    !Number.isFinite(inputPercent) ||
    inputPercent < 0 ||
    inputPercent > 100 ||
    !Number.isFinite(cachePercent) ||
    cachePercent < 0 ||
    cachePercent > 100 ||
    !price ||
    !Number.isFinite(price.input) ||
    price.input < 0 ||
    !Number.isFinite(price.output) ||
    price.output < 0 ||
    (price.cachedInput !== null &&
      (!Number.isFinite(price.cachedInput) || price.cachedInput < 0))
  )
    return null;
  const inputTokens = (totalTokens * inputPercent) / 100;
  const outputTokens = totalTokens - inputTokens;
  const cachedInputTokens = (inputTokens * cachePercent) / 100;
  const uncachedInputTokens = inputTokens - cachedInputTokens;
  const uncachedInputCost = (uncachedInputTokens * price.input) / 1_000_000;
  const outputCost = (outputTokens * price.output) / 1_000_000;
  // 只有实际假定了缓存输入时，才需要已公布的缓存单价。
  const cachedInputCost =
    cachePercent === 0 || inputTokens === 0
      ? 0
      : price.cachedInput === null
        ? null
        : (cachedInputTokens * price.cachedInput) / 1_000_000;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    noCache: (inputTokens * price.input) / 1_000_000 + outputCost,
    withCache:
      cachedInputCost === null
        ? null
        : uncachedInputCost + cachedInputCost + outputCost,
    uncachedInputCost,
    cachedInputCost,
    outputCost,
  };
}

// 差值以 A 为基准：负数表示 B 更便宜。零基准不计算百分比。
function costDifference(
  a: number | null | undefined,
  b: number | null | undefined,
) {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b))
    return null;
  const delta = b - a;
  const amount =
    Math.abs(delta) <= Number.EPSILON * Math.max(a, b) * 4 ? 0 : delta;
  return { amount, percent: a > 0 ? (amount / a) * 100 : null };
}

export function compareQuotaCosts(
  totalTokens: number | null,
  inputPercent: number,
  referencePrice: ModelPrice | undefined,
  comparisonPrice: ModelPrice | undefined,
  cachePercent = 90,
) {
  // 两个模型只替换单价，共享同一份用量及输入、缓存假设。
  const reference = estimateQuotaCost(
    totalTokens,
    inputPercent,
    referencePrice,
    cachePercent,
  );
  const comparison = estimateQuotaCost(
    totalTokens,
    inputPercent,
    comparisonPrice,
    cachePercent,
  );
  return {
    reference,
    comparison,
    noCache: costDifference(reference?.noCache, comparison?.noCache),
    withCache: costDifference(reference?.withCache, comparison?.withCache),
  };
}

export type CostComparison = ReturnType<typeof compareQuotaCosts>;
