import { useCallback, useEffect, useRef, useState } from "react";
import {
  getQuotaRefreshState,
  initializeQuotaRefresh,
  refreshQuotas,
  setBackgroundQuotaRefresh,
  subscribeQuotaRefresh,
} from "./quotaRefreshApi";
import { newerQuotaState } from "./quotaRefreshState";
import type { QuotaRefreshState } from "./quotaRefreshState";
import { localizeBackendError } from "./i18n";
import type { Locale } from "./i18n";

const STORAGE_KEY = "codex-auth-switch-background-quota-refresh";
const legacyPreference = () =>
  (window.localStorage.getItem(STORAGE_KEY) ??
    window.localStorage.getItem("codex-auth-switch-auto-refresh-usage")) !==
  "false";
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function useAccountQuotas(locale: Locale) {
  const [state, setState] = useState<QuotaRefreshState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [preferenceSaving, setPreferenceSaving] = useState(false);
  const saving = useRef(false);
  const accept = useCallback(
    (next: QuotaRefreshState) =>
      setState((current) => newerQuotaState(current, next)),
    [],
  );
  useEffect(() => {
    const legacyEnabled = legacyPreference();
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const receive = (next: QuotaRefreshState) => {
      if (!disposed) accept(next);
    };
    void (async () => {
      try {
        const stop = await subscribeQuotaRefresh(receive);
        if (disposed) {
          stop();
          return;
        }
        unsubscribe = stop;
        receive(await initializeQuotaRefresh(legacyEnabled));
      } catch (reason) {
        if (!disposed) setPreferenceError(messageOf(reason));
        // 偏好文件损坏时后端保持关闭，界面也回显实际状态。
        try {
          receive(await getQuotaRefreshState());
        } catch {
          /* 保留设置错误。 */
        }
      }
    })();
    // WebView 恢复后补取最新缓存；不因此触发网络查询。
    const sync = () => {
      if (document.visibilityState === "hidden") return;
      void getQuotaRefreshState()
        .then(receive)
        .catch(() => {});
    };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      disposed = true;
      unsubscribe?.();
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [accept]);
  useEffect(() => {
    if (state) window.localStorage.setItem(STORAGE_KEY, String(state.enabled));
  }, [state?.enabled]);
  const refresh = useCallback(
    async (profileId?: string) => {
      setError(null);
      try {
        accept(await refreshQuotas(profileId ? [profileId] : undefined));
      } catch (reason) {
        setError(messageOf(reason));
      }
    },
    [accept],
  );
  const setEnabled = useCallback(
    async (enabled: boolean) => {
      if (saving.current) return;
      saving.current = true;
      setPreferenceSaving(true);
      setPreferenceError(null);
      try {
        accept(await setBackgroundQuotaRefresh(enabled));
      } catch (reason) {
        setPreferenceError(messageOf(reason));
      } finally {
        saving.current = false;
        setPreferenceSaving(false);
      }
    },
    [accept],
  );
  return {
    quotas: state?.quotas ?? null,
    quotaRefreshingIds: state?.refreshingIds ?? [],
    quotaRefreshErrors: state?.errors ?? {},
    quotaLoading: Boolean(state?.refreshingIds.length),
    quotaError: error ? localizeBackendError(error, locale) : null,
    backgroundRefresh: state?.enabled ?? legacyPreference(),
    backgroundRefreshSaving: preferenceSaving,
    backgroundRefreshError: preferenceError
      ? localizeBackendError(preferenceError, locale)
      : null,
    setBackgroundRefresh: setEnabled,
    refreshQuotas: refresh,
  };
}
