import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateDailyUsage,
  compareQuotaNumbers,
  formatCount,
  nextQuotaReset,
  normalizeDailyUsage,
  quotaLevel,
  recentTokenUsage,
  summarizeQuotas,
} from "../src/quotaView.ts";

const day = (offset) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

const quota = (overrides = {}) => ({
  profileId: "profile-1",
  accountId: "account-1",
  label: "Test account",
  primary: { usedPercent: 20, windowMinutes: 300, resetsAt: null },
  secondary: null,
  buckets: [],
  resetCredits: { availableCount: 2, expiresAt: [] },
  planType: "pro",
  officialUsage: {
    lifetimeTokens: 100,
    peakDailyTokens: 100,
    longestRunningTurnSec: null,
    currentStreakDays: null,
    longestStreakDays: null,
    dailyUsageBuckets: [
      { startDate: day(0), tokens: 10 },
      { startDate: day(-6), tokens: 20 },
      { startDate: day(-7), tokens: 30 },
      { startDate: day(-29), tokens: 40 },
      { startDate: day(-30), tokens: 50 },
    ],
  },
  source: "appServer",
  success: true,
  error: null,
  queriedAt: 100,
  ...overrides,
});

test("recent usage includes UTC boundaries and excludes future/invalid buckets", () => {
  const buckets = [
    ...quota().officialUsage.dailyUsageBuckets,
    { startDate: day(1), tokens: 100 },
    { startDate: "2026-02-30", tokens: 100 },
    { startDate: day(-1), tokens: NaN },
    { startDate: day(-2), tokens: -100 },
  ];
  assert.equal(recentTokenUsage(buckets, 7).tokens, 30);
  assert.equal(recentTokenUsage(buckets, 30).tokens, 100);
  assert.equal(recentTokenUsage([], 7), null);
});

test("summary sums known accounts without treating missing usage as zero", () => {
  const result = summarizeQuotas([
    quota(),
    quota({
      accountId: "account-2",
      profileId: "profile-2",
      officialUsage: null,
      resetCredits: null,
    }),
    quota({ accountId: "failed", success: false }),
  ]);
  assert.equal(result.successful, 2);
  assert.deepEqual(result.sevenDays, { tokens: 30, count: 1 });
  assert.deepEqual(result.thirtyDays, { tokens: 100, count: 1 });
  assert.equal(result.credits, 2);
  assert.equal(result.creditAccounts, 1);
});

test("summary deduplicates subscription accounts and takes the latest successful result", () => {
  const original = quota();
  const newer = quota({
    profileId: "duplicate",
    queriedAt: 200,
    resetCredits: { availableCount: 3, expiresAt: [] },
  });
  const failed = quota({ profileId: "failed", queriedAt: 300, success: false });
  const result = summarizeQuotas([newer, original, failed]);
  assert.equal(result.successful, 1);
  assert.equal(result.credits, 3);
  assert.equal(result.sevenDays.tokens, 30);
});

test("unknown totals differ from confirmed zero usage and credits", () => {
  const missing = summarizeQuotas([
    quota({ officialUsage: null, resetCredits: null }),
  ]);
  assert.deepEqual(missing.sevenDays, { tokens: null, count: 0 });
  assert.equal(missing.credits, null);
  const zero = quota();
  zero.officialUsage.dailyUsageBuckets = [{ startDate: day(0), tokens: 0 }];
  zero.resetCredits.availableCount = 0;
  assert.deepEqual(summarizeQuotas([zero]).sevenDays, { tokens: 0, count: 1 });
  assert.equal(summarizeQuotas([zero]).credits, 0);
  assert.equal(summarizeQuotas([]).successful, 0);
});

test("sorts missing values last in either direction, preserving ties", () => {
  const values = [null, 40, 0, 80, null];
  assert.deepEqual(
    [...values].sort((a, b) => compareQuotaNumbers(a, b)),
    [0, 40, 80, null, null],
  );
  assert.deepEqual(
    [...values].sort((a, b) => compareQuotaNumbers(a, b, true)),
    [80, 40, 0, null, null],
  );
  assert.equal(compareQuotaNumbers(null, null), 0);
  assert.equal(compareQuotaNumbers(4, 4), 0);
});

test("recovery and health consider model-specific windows", () => {
  const now = Math.floor(Date.now() / 1000);
  const value = quota({
    buckets: [
      {
        id: "model",
        name: "Model quota",
        primary: { usedPercent: 95, windowMinutes: 300, resetsAt: now - 60 },
        secondary: {
          usedPercent: 10,
          windowMinutes: 10080,
          resetsAt: now + 600,
        },
      },
    ],
  });
  assert.equal(nextQuotaReset(value), now + 600);
  assert.equal(quotaLevel(value), "tight");
  assert.equal(nextQuotaReset({ ...value, success: false }), null);
  assert.equal(nextQuotaReset(null), null);
  assert.equal(nextQuotaReset(quota()), null);
});

test("compact totals preserve Chinese units and distinguish unknown values", () => {
  assert.equal(formatCount(29_100_000, "zh-CN"), "0.29亿");
  assert.equal(formatCount(1_900_000_000, "zh-CN"), "19亿");
  assert.equal(formatCount(12_000, "zh-CN"), "1.2万");
  assert.equal(formatCount(null, "zh-CN"), "—");
  assert.equal(formatCount(0, "zh-CN"), "0");
});

test("daily activity sums accounts by date and preserves recorded zero days", () => {
  const first = quota();
  first.officialUsage.dailyUsageBuckets = [
    { startDate: day(-1), tokens: 20 },
    { startDate: day(0), tokens: 0 },
  ];
  const second = quota({ accountId: "account-2" });
  second.officialUsage.dailyUsageBuckets = [
    { startDate: day(-2), tokens: 10 },
    { startDate: day(-1), tokens: 30 },
  ];
  assert.deepEqual(aggregateDailyUsage([first, second]), {
    accountCount: 2,
    buckets: [
      { startDate: day(-2), tokens: 10 },
      { startDate: day(-1), tokens: 50 },
      { startDate: day(0), tokens: 0 },
    ],
  });
  assert.equal(first.officialUsage.dailyUsageBuckets[0].tokens, 20);
});

test("daily activity deduplicates profiles and days and skips failed or invalid data", () => {
  const newest = quota({ queriedAt: 200, profileId: "newest" });
  newest.officialUsage.dailyUsageBuckets = [
    { startDate: day(0), tokens: 10 },
    { startDate: day(0), tokens: 20 },
    { startDate: day(-1), tokens: -5 },
    { startDate: "invalid", tokens: 100 },
    { startDate: day(-2), tokens: Infinity },
  ];
  const result = aggregateDailyUsage([
    newest,
    quota(),
    quota({ accountId: "failed", success: false }),
    quota({ accountId: "missing", officialUsage: null }),
  ]);
  assert.deepEqual(result, {
    accountCount: 1,
    buckets: [
      { startDate: day(-1), tokens: 0 },
      { startDate: day(0), tokens: 20 },
    ],
  });
  assert.deepEqual(aggregateDailyUsage([]), { accountCount: 0, buckets: [] });
  assert.deepEqual(aggregateDailyUsage([quota({ officialUsage: null })]), {
    accountCount: 0,
    buckets: [],
  });
});

test("recent totals and activity use the same daily normalization", () => {
  const account = quota();
  const buckets = [
    { startDate: day(0), tokens: 10 },
    { startDate: day(0), tokens: 20 },
    { startDate: day(0), tokens: NaN },
    { startDate: day(-1), tokens: -5 },
    { startDate: "2026-02-30", tokens: 999 },
  ];
  account.officialUsage.dailyUsageBuckets = buckets;
  assert.deepEqual(
    [...normalizeDailyUsage(buckets)],
    [
      [day(0), 20],
      [day(-1), 0],
    ],
  );
  const activity = aggregateDailyUsage([account]);
  const total = activity.buckets.reduce(
    (sum, bucket) => sum + bucket.tokens,
    0,
  );
  assert.equal(total, 20);
  assert.equal(recentTokenUsage(buckets, 7).tokens, total);
  assert.equal(recentTokenUsage(buckets, 30).tokens, total);
  assert.equal(summarizeQuotas([account]).sevenDays.tokens, total);
});
