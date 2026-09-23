import type { AccountQuota } from "./api";

export type QuotaRefreshState = {
  enabled: boolean;
  revision: number;
  quotas: AccountQuota[];
  refreshingIds: string[];
  errors: Record<string, string>;
};

// 事件、初始化响应和窗口恢复读取可能乱序，只接受较新的完整快照。
export const newerQuotaState = (
  current: QuotaRefreshState | null,
  next: QuotaRefreshState,
): QuotaRefreshState =>
  !current || next.revision >= current.revision ? next : current;
