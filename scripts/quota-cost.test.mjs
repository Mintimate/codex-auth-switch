import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateQuotaCost } from "../src/quotaCost.ts";
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
    noCache: 18,
    cache90: 11.52,
  });
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
  assert.equal(estimateQuotaCost(1_000_000, 100, price).cache90, 1.9);
  assert.deepEqual(estimateQuotaCost(1_000_000, 0, price), {
    inputTokens: 0,
    outputTokens: 1_000_000,
    noCache: 50,
    cache90: 50,
  });
});

test("unknown totals, models and invalid inputs never display as free usage", () => {
  for (const total of [null, NaN, Infinity, -1])
    assert.equal(estimateQuotaCost(total, 80, price), null);
  for (const ratio of [-1, 101, NaN])
    assert.equal(estimateQuotaCost(1, ratio, price), null);
  assert.equal(estimateQuotaCost(1, 80, undefined), null);
  assert.equal(estimateQuotaCost(1, 80, { ...price, cachedInput: NaN }), null);
  assert.equal(estimateQuotaCost(1, 80, { ...price, input: Infinity }), null);
  assert.deepEqual(estimateQuotaCost(0, 80, price), {
    inputTokens: 0,
    outputTokens: 0,
    noCache: 0,
    cache90: 0,
  });
});

test("no published cache price leaves that scenario unavailable", () => {
  const estimate = estimateQuotaCost(1_000_000, 80, {
    ...price,
    cachedInput: null,
  });
  assert.equal(estimate.noCache, 18);
  assert.equal(estimate.cache90, null);
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
