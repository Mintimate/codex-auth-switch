import assert from "node:assert/strict";
import { test } from "node:test";
import { quotaChange } from "../src/quotaHistory.ts";

const point = (overrides = {}) => ({ profileId: "p", bucketId: "codex", window: "primary", source: "appServer", planType: "plus", windowMinutes: 300, queriedAt: 100, resetsAt: 1000, usedPercent: 10, ...overrides });

test("same-period observations report percentage points, including corrections", () => {
  assert.deepEqual(quotaChange(point(), point({ queriedAt: 200, usedPercent: 18.4 })), { kind: "increased", points: 8.4 });
  assert.deepEqual(quotaChange(point(), point({ queriedAt: 200, usedPercent: 3 })), { kind: "recovered", points: 7 });
  assert.equal(quotaChange(point(), point({ queriedAt: 200 })).kind, "unchanged");
  assert.equal(quotaChange(undefined, point()).kind, "first");
});

test("reset boundaries and expired window timestamps cannot be reported as consumption", () => {
  assert.deepEqual(quotaChange(point(), point({ queriedAt: 200, resetsAt: 2000, usedPercent: 2 })), { kind: "period", points: null });
  assert.equal(quotaChange(point(), point({ queriedAt: 1000 })).kind, "period");
});

test("changes of identity, source, plan or missing metadata break comparability", () => {
  for (const change of [{ profileId: "other" }, { bucketId: "other" }, { window: "secondary" }, { source: "compatibility" }, { planType: "pro" }, { windowMinutes: 10080 }, { windowMinutes: null }, { resetsAt: null }, { queriedAt: 99 }, { queriedAt: 100 }, { usedPercent: NaN }]) {
    assert.deepEqual(quotaChange(point(), point({ queriedAt: 200, ...change })), { kind: "incomparable", points: null });
  }
});
