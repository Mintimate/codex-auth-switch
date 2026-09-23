import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { QuotaRefreshState } from "./quotaRefreshState";

const isPreview = () =>
  import.meta.env.DEV && !("__TAURI_INTERNALS__" in window);
const preview = () => import("./quotaRefreshPreview");

export const initializeQuotaRefresh = async (legacyEnabled: boolean) =>
  isPreview()
    ? (await preview()).initialize(legacyEnabled)
    : invoke<QuotaRefreshState>("initialize_quota_refresh", { legacyEnabled });
export const getQuotaRefreshState = async () =>
  isPreview()
    ? (await preview()).snapshot()
    : invoke<QuotaRefreshState>("get_quota_refresh_state");
export const setBackgroundQuotaRefresh = async (enabled: boolean) =>
  isPreview()
    ? (await preview()).setEnabled(enabled)
    : invoke<QuotaRefreshState>("set_background_quota_refresh", { enabled });
export const refreshQuotas = async (profileIds?: string[]) =>
  isPreview()
    ? (await preview()).refresh(profileIds)
    : invoke<QuotaRefreshState>("refresh_account_quotas", {
        profileIds: profileIds ?? null,
      });
export const subscribeQuotaRefresh = async (
  onChange: (state: QuotaRefreshState) => void,
) =>
  isPreview()
    ? (await preview()).subscribe(onChange)
    : listen<QuotaRefreshState>("quota-refresh-state", ({ payload }) =>
        onChange(payload),
      );
