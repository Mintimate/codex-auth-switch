// 仅供网页预览；桌面版的调度和缓存完全由 Rust 管理。
import { getAccountQuotas, getStatus, refreshPreviewQuotas } from "./api";
import type { QuotaRefreshState } from "./quotaRefreshState";
import { isPublicDemo } from "./runtime";

let state: QuotaRefreshState = {
  enabled: false,
  revision: 0,
  quotas: [],
  refreshingIds: [],
  errors: {},
};
let initialized = false;
let timer: number | undefined;
const listeners = new Set<(state: QuotaRefreshState) => void>();
const finished = new Map<string, number>();
export const snapshot = () => structuredClone(state);
const publish = () => {
  state.revision += 1;
  listeners.forEach((listener) => listener(snapshot()));
};
export function subscribe(listener: (state: QuotaRefreshState) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export async function refresh(selected?: string[]) {
  const status = await getStatus();
  if (!status.supported) return snapshot();
  const ids = status.accounts
    .map((a) => a.id)
    .filter(
      (id) =>
        (!selected || selected.includes(id)) &&
        !state.refreshingIds.includes(id),
    );
  if (!ids.length) return snapshot();
  state.refreshingIds.push(...ids);
  publish();
  try {
    await refreshPreviewQuotas(ids, (quota) => {
      state.quotas = [
        ...state.quotas.filter((q) => q.profileId !== quota.profileId),
        quota,
      ];
      state.refreshingIds = state.refreshingIds.filter(
        (id) => id !== quota.profileId,
      );
      finished.set(quota.profileId, Date.now());
      publish();
    });
  } finally {
    state.refreshingIds = state.refreshingIds.filter((id) => !ids.includes(id));
    publish();
  }
  return snapshot();
}
async function tick() {
  if (!state.enabled) return;
  const status = await getStatus();
  const ids = status.accounts
    .filter((a) => Date.now() - (finished.get(a.id) ?? 0) >= 15 * 60_000)
    .map((a) => a.id);
  // 等待读取状态期间，用户可能关闭开关。
  if (state.enabled && ids.length) await refresh(ids);
}
export async function initialize(enabled: boolean) {
  if (!initialized) {
    initialized = true;
    state.enabled = enabled;
    if (isPublicDemo) state.quotas = await getAccountQuotas();
    publish();
    if (!isPublicDemo) timer = window.setInterval(() => void tick(), 30_000);
    void tick();
  }
  return snapshot();
}
export function setEnabled(enabled: boolean) {
  state.enabled = enabled;
  publish();
  if (enabled) void tick();
  return snapshot();
}
import.meta.hot?.dispose(() => {
  window.clearInterval(timer);
});
