import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newerQuotaState } from '../src/quotaRefreshState.ts';
const state = (revision, enabled = true) => ({ revision, enabled, quotas: [], refreshingIds: [], errors: {} });
test('late initialization and resume reads cannot overwrite newer background events', () => {
  const current = state(5);
  assert.equal(newerQuotaState(current, state(3)), current);
  assert.equal(newerQuotaState(current, state(6)).revision, 6);
  assert.equal(newerQuotaState(null, current), current);
});
test('a stale enabled response cannot undo a confirmed disabled preference', () => {
  const off = state(8, false);
  assert.equal(newerQuotaState(off, state(7, true)).enabled, false);
});
