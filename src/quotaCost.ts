import type { ModelPrice } from "./api";

// 账号每日用量只有总数。模型和输入占比均由用户指定，不能伪称实际用量拆分。
export function estimateQuotaCost(
  totalTokens: number | null,
  inputPercent: number,
  price: ModelPrice | undefined,
) {
  if (
    totalTokens === null ||
    !Number.isFinite(totalTokens) ||
    totalTokens < 0 ||
    !Number.isFinite(inputPercent) ||
    inputPercent < 0 ||
    inputPercent > 100 ||
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
  const outputCost = outputTokens * price.output;
  return {
    inputTokens,
    outputTokens,
    noCache: (inputTokens * price.input + outputCost) / 1_000_000,
    // 未公布缓存价格时不虚构缓存折扣。
    cache90:
      price.cachedInput === null
        ? null
        : (inputTokens * (0.1 * price.input + 0.9 * price.cachedInput) +
            outputCost) /
          1_000_000,
  };
}
