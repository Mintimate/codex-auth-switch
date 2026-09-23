import assert from "node:assert/strict";
import { test } from "node:test";
import { compareQuotaCosts, estimateQuotaCost } from "../src/quotaCost.ts";
import { summarizeQuotas } from "../src/quotaView.ts";

const price = {
  model: "reference",
  input: 10,
  cachedInput: 1,
  cacheWrite: 12.5,
  output: 50,
};
const quota = (accountId, total, overrides = {}) => ({
  accountId,
  profileId: accountId,
  queriedAt: 1,
  success: true,
  resetCredits: null,
  officialUsage:
    total === null
      ? null
      : {
          dailyUsageBuckets: [
            { startDate: new Date().toISOString().slice(0, 10), tokens: total },
          ],
        },
  ...overrides,
});

test("account total is split only by the explicit assumed input ratio", () => {
  assert.deepEqual(estimateQuotaCost(1_000_000, 80, price), {
    inputTokens: 800_000,
    outputTokens: 200_000,
    cachedInputTokens: 720_000,
    uncachedInputTokens: 80_000,
    noCache: 18,
    withCache: 11.52,
    uncachedInputCost: 0.8,
    cachedInputCost: 0.72,
    outputCost: 10,
  });
});

test("cache ratios of 0, 50, 90 and 100 percent split only the input tokens", () => {
  for (const [cachePercent, cachedTokens, uncachedTokens, cost] of [
    [0, 0, 800_000, 18],
    [50, 400_000, 400_000, 14.4],
    [90, 720_000, 80_000, 11.52],
    [100, 800_000, 0, 10.8],
  ]) {
    const estimate = estimateQuotaCost(1_000_000, 80, price, cachePercent);
    assert.equal(estimate.cachedInputTokens, cachedTokens);
    assert.equal(estimate.uncachedInputTokens, uncachedTokens);
    assert.equal(
      estimate.cachedInputTokens +
        estimate.uncachedInputTokens +
        estimate.outputTokens,
      1_000_000,
    );
    assert.equal(estimate.withCache, cost);
    assert.equal(estimate.noCache, 18);
    assert.equal(estimate.outputTokens, 200_000);
    assert.equal(estimate.outputCost, 10);
  }
});

test("fractional input shares preserve small output costs", () => {
  const estimate = estimateQuotaCost(1_000_000, 99.7, price, 90);
  assert.equal(estimate.inputTokens, 997_000);
  assert.equal(estimate.outputTokens, 3_000);
  assert.equal(estimate.cachedInputTokens, 897_300);
  assert.equal(estimate.uncachedInputTokens, 99_700);
  assert.equal(estimate.uncachedInputCost, 0.997);
  assert.equal(estimate.cachedInputCost, 0.8973);
  assert.equal(estimate.outputCost, 0.15);
  assert.equal(estimate.withCache, 2.0443);
});

test("cost components add up at small and large token totals", () => {
  for (const total of [0, 1, 12_345, 1_000_000, 4_280_000_000]) {
    for (const inputPercent of [0, 75, 99.7, 100]) {
      for (const cachePercent of [0, 50, 90, 100]) {
        const estimate = estimateQuotaCost(
          total,
          inputPercent,
          price,
          cachePercent,
        );
        assert.equal(
          estimate.withCache,
          estimate.uncachedInputCost +
            estimate.cachedInputCost +
            estimate.outputCost,
        );
        assert.ok(estimate.withCache <= estimate.noCache + 1e-10);
      }
    }
  }
});

test("changing model or input share changes both scenarios without adding tokens", () => {
  assert.equal(estimateQuotaCost(1_000_000, 50, price).noCache, 30);
  assert.equal(
    estimateQuotaCost(1_000_000, 80, {
      ...price,
      input: 2,
      output: 10,
      cachedInput: 0.2,
    }).noCache,
    3.6,
  );
  assert.equal(estimateQuotaCost(1_000_000, 100, price).withCache, 1.9);
  assert.deepEqual(estimateQuotaCost(1_000_000, 0, price), {
    inputTokens: 0,
    outputTokens: 1_000_000,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    noCache: 50,
    withCache: 50,
    uncachedInputCost: 0,
    cachedInputCost: 0,
    outputCost: 50,
  });
});

test("unknown totals, models and invalid inputs never display as free usage", () => {
  for (const total of [null, NaN, Infinity, -1])
    assert.equal(estimateQuotaCost(total, 80, price), null);
  for (const ratio of [-1, 101, NaN, Infinity, -Infinity]) {
    assert.equal(estimateQuotaCost(1, ratio, price), null);
    assert.equal(estimateQuotaCost(1, 80, price, ratio), null);
  }
  assert.equal(estimateQuotaCost(1, 80, undefined), null);
  assert.equal(estimateQuotaCost(1, 80, { ...price, cachedInput: NaN }), null);
  assert.equal(estimateQuotaCost(1, 80, { ...price, input: Infinity }), null);
  assert.equal(estimateQuotaCost(1, 80, { ...price, output: -1 }), null);
  assert.deepEqual(estimateQuotaCost(0, 80, price), {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    noCache: 0,
    withCache: 0,
    uncachedInputCost: 0,
    cachedInputCost: 0,
    outputCost: 0,
  });
});

test("no published cache price leaves scenarios with cached input unavailable", () => {
  const unknownCachePrice = {
    ...price,
    cachedInput: null,
  };
  for (const cachePercent of [50, 90, 100]) {
    const estimate = estimateQuotaCost(
      1_000_000,
      80,
      unknownCachePrice,
      cachePercent,
    );
    assert.equal(estimate.noCache, 18);
    assert.equal(estimate.withCache, null);
    assert.equal(estimate.cachedInputCost, null);
    assert.equal(estimate.outputCost, 10);
  }
});

test("zero cached input and zero usage do not require a published cache price", () => {
  const unknownCachePrice = { ...price, cachedInput: null };
  const noCache = estimateQuotaCost(1_000_000, 80, unknownCachePrice, 0);
  assert.equal(noCache.withCache, 18);
  assert.equal(noCache.cachedInputCost, 0);
  const outputOnly = estimateQuotaCost(1_000_000, 0, unknownCachePrice, 100);
  assert.equal(outputOnly.withCache, 50);
  assert.equal(outputOnly.cachedInputCost, 0);
  for (const cachePercent of [0, 50, 90, 100]) {
    const zeroUsage = estimateQuotaCost(0, 80, unknownCachePrice, cachePercent);
    assert.equal(zeroUsage.noCache, 0);
    assert.equal(zeroUsage.withCache, 0);
    assert.equal(zeroUsage.cachedInputCost, 0);
  }
});

test("subscription summaries exclude missing and failed data and deduplicate accounts", () => {
  const rows = [
    quota("a", 1),
    quota("a", 1_000_000, { profileId: "duplicate", queriedAt: 2 }),
    quota("b", null),
    quota("c", 50, { success: false }),
  ];
  const summary = summarizeQuotas(rows);
  assert.deepEqual(summary.sevenDays, { tokens: 1_000_000, count: 1 });
  assert.equal(
    estimateQuotaCost(summary.thirtyDays.tokens, 80, price).noCache,
    18,
  );
  const unavailable = summarizeQuotas([rows[2], rows[3]]);
  assert.equal(
    estimateQuotaCost(unavailable.sevenDays.tokens, 80, price),
    null,
  );
  const single = summarizeQuotas(
    rows.filter((row) => row.profileId === "duplicate"),
  );
  assert.equal(single.sevenDays.tokens, 1_000_000);
});

test("simulation uses the same 7 / 30 day boundaries as the quota page", () => {
  const date = (offset) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const row = quota("a", 0, {
    officialUsage: {
      dailyUsageBuckets: [
        { startDate: date(0), tokens: 100 },
        { startDate: date(-6), tokens: 200 },
        { startDate: date(-7), tokens: 300 },
        { startDate: date(-29), tokens: 400 },
        { startDate: date(-30), tokens: 1000 },
        { startDate: date(1), tokens: 1000 },
      ],
    },
  });
  const summary = summarizeQuotas([row]);
  assert.equal(summary.sevenDays.tokens, 300);
  assert.equal(summary.thirtyDays.tokens, 1000);
  assert.equal(
    estimateQuotaCost(summary.sevenDays.tokens, 80, price).noCache,
    0.0054,
  );
});

test("model comparison shares token assumptions and reports B relative to A", () => {
  const cheaper = {
    ...price,
    model: "comparison",
    input: 5,
    cachedInput: 0.5,
    output: 25,
  };
  const result = compareQuotaCosts(1_000_000, 80, price, cheaper, 50);
  assert.equal(result.reference.withCache, 14.4);
  assert.equal(result.comparison.withCache, 7.2);
  assert.deepEqual(result.withCache, { amount: -7.2, percent: -50 });
  assert.deepEqual(result.noCache, { amount: -9, percent: -50 });
  for (const field of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "uncachedInputTokens",
  ])
    assert.equal(result.reference[field], result.comparison[field]);
  const swapped = compareQuotaCosts(1_000_000, 80, cheaper, price, 50);
  assert.deepEqual(swapped.withCache, { amount: 7.2, percent: 100 });
  assert.deepEqual(swapped.noCache, { amount: 9, percent: 100 });
});

test("model comparison keeps cache scenarios independent and handles missing prices", () => {
  const withoutCache = { ...price, cachedInput: null };
  for (const [a, b] of [
    [price, withoutCache],
    [withoutCache, price],
  ]) {
    const result = compareQuotaCosts(1_000_000, 80, a, b, 90);
    assert.equal(result.withCache, null);
    assert.deepEqual(result.noCache, { amount: 0, percent: 0 });
    const uncached = compareQuotaCosts(1_000_000, 80, a, b, 0);
    assert.deepEqual(uncached.withCache, { amount: 0, percent: 0 });
  }
  for (const [a, b] of [
    [price, undefined],
    [undefined, price],
  ]) {
    const result = compareQuotaCosts(1_000_000, 80, a, b);
    assert.equal(result.withCache, null);
    assert.equal(result.noCache, null);
  }
});

test("comparison distinguishes missing usage, zero usage, and a zero cost baseline", () => {
  const missing = compareQuotaCosts(null, 80, price, price);
  assert.equal(missing.withCache, null);
  assert.equal(missing.noCache, null);
  const zeroUsage = compareQuotaCosts(0, 80, price, price);
  assert.deepEqual(zeroUsage.withCache, { amount: 0, percent: null });
  const free = { ...price, input: 0, cachedInput: 0, output: 0 };
  const zeroBaseline = compareQuotaCosts(1_000_000, 80, free, price);
  assert.deepEqual(zeroBaseline.withCache, { amount: 11.52, percent: null });
  const freeComparison = compareQuotaCosts(1_000_000, 80, price, free);
  assert.deepEqual(freeComparison.withCache, { amount: -11.52, percent: -100 });
});

test("comparison updates both scenarios with ratios and preserves sub-cent differences", () => {
  const other = { ...price, input: 2, cachedInput: 0.5, output: 60 };
  const inputOnly = compareQuotaCosts(1_000_000, 100, price, other, 100);
  assert.deepEqual(inputOnly.withCache, { amount: -0.5, percent: -50 });
  const outputOnly = compareQuotaCosts(1_000_000, 0, price, other, 100);
  assert.deepEqual(outputOnly.withCache, { amount: 10, percent: 20 });
  assert.deepEqual(outputOnly.withCache, outputOnly.noCache);
  const tiny = compareQuotaCosts(1, 100, price, other, 100);
  assert.equal(tiny.withCache.amount, -0.0000005);
  const same = compareQuotaCosts(1_000_000, 99.7, price, price, 90);
  assert.deepEqual(same.withCache, { amount: 0, percent: 0 });
});
