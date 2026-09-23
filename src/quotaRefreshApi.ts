import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { QuotaRefreshState } from "./quotaRefreshState";
import { demoReadOnlyError, isBrowserPreview, isPublicDemo } from "./runtime";

const preview = () => import("./quotaRefreshPreview");

export const initializeQuotaRefresh = async (legacyEnabled: boolean) =>
  isBrowserPreview()
    ? (await preview()).initialize(isPublicDemo ? false : legacyEnabled)
    : invoke<QuotaRefreshState>("initialize_quota_refresh", { legacyEnabled });
export const getQuotaRefreshState = async () =>
  isBrowserPreview()
    ? (await preview()).snapshot()
    : invoke<QuotaRefreshState>("get_quota_refresh_state");
export const setBackgroundQuotaRefresh = async (enabled: boolean) => {
  if (isPublicDemo) throw demoReadOnlyError();
  return isBrowserPreview()
    ? (await preview()).setEnabled(enabled)
    : invoke<QuotaRefreshState>("set_background_quota_refresh", { enabled });
};
export const refreshQuotas = async (profileIds?: string[]) =>
  isBrowserPreview()
    ? (await preview()).refresh(profileIds)
    : invoke<QuotaRefreshState>("refresh_account_quotas", {
        profileIds: profileIds ?? null,
      });
export const subscribeQuotaRefresh = async (
  onChange: (state: QuotaRefreshState) => void,
) =>
  isBrowserPreview()
    ? (await preview()).subscribe(onChange)
    : listen<QuotaRefreshState>("quota-refresh-state", ({ payload }) =>
        onChange(payload),
      );
