import type { QuotaPoint } from "./api";

export type QuotaChange = {
  kind:
    | "first"
    | "incomparable"
    | "period"
    | "recovered"
    | "increased"
    | "unchanged";
  points: number | null;
};

// 百分比只在同一账号、额度池、数据来源、套餐和明确的同一窗口内比较。
export function quotaChange(
  previous: QuotaPoint | undefined,
  current: QuotaPoint,
): QuotaChange {
  if (!previous) return { kind: "first", points: null };
  if (
    previous.profileId !== current.profileId ||
    previous.bucketId !== current.bucketId ||
    previous.window !== current.window ||
    previous.source !== current.source ||
    previous.planType !== current.planType ||
    !current.windowMinutes ||
    previous.windowMinutes !== current.windowMinutes ||
    current.queriedAt <= previous.queriedAt ||
    !Number.isFinite(previous.usedPercent) ||
    !Number.isFinite(current.usedPercent)
  )
    return { kind: "incomparable", points: null };
  if (!current.resetsAt || !previous.resetsAt)
    return { kind: "incomparable", points: null };
  if (
    current.resetsAt !== previous.resetsAt ||
    current.queriedAt >= current.resetsAt ||
    previous.queriedAt >= previous.resetsAt
  )
    return { kind: "period", points: null };
  const delta =
    Math.round((current.usedPercent - previous.usedPercent) * 10) / 10;
  return {
    kind: delta < 0 ? "recovered" : delta > 0 ? "increased" : "unchanged",
    points: Math.abs(delta),
  };
}
