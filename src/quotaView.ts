import { AccountQuota, AccountUsageDailyBucket, UsageWindow } from "./api";
import { Locale, Translate } from "./i18n";

export type QuotaLevel =
  "healthy" | "attention" | "tight" | "unknown" | "error";

export type QuotaEvent = {
  accountId: string;
  accountLabel: string;
  at: number;
  detail: string;
  kind: "reset" | "expiry";
};

const TOKEN_UNITS = [
  { minimum: 1_000_000_000, suffix: "B" },
  { minimum: 1_000_000, suffix: "M" },
  { minimum: 1_000, suffix: "K" },
];

export const formatWindow = (minutes: number | null, t: Translate) => {
  if (!minutes) return t("quotaWindow");
  if (minutes % 1440 === 0) {
    return t("daysWindow", { count: minutes / 1440 });
  }
  if (minutes % 60 === 0) {
    return t("hoursWindow", { count: minutes / 60 });
  }
  return t("minutesWindow", { count: minutes });
};

export const formatDate = (
  timestamp: number,
  locale: Locale,
  includeYear = false,
) =>
  new Intl.DateTimeFormat(locale, {
    ...(includeYear ? { year: "numeric" as const } : {}),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp * 1000);

export const formatRelative = (timestamp: number, locale: Locale) => {
  const seconds = timestamp - Date.now() / 1000;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(seconds) < 60 * 60) {
    const minutes = Math.max(1, Math.round(Math.abs(seconds) / 60));
    return formatter.format(seconds < 0 ? -minutes : minutes, "minute");
  }
  if (Math.abs(seconds) < 48 * 60 * 60) {
    const hours = Math.max(1, Math.round(Math.abs(seconds) / 3600));
    return formatter.format(seconds < 0 ? -hours : hours, "hour");
  }
  const days = Math.max(1, Math.round(Math.abs(seconds) / 86400));
  return formatter.format(seconds < 0 ? -days : days, "day");
};

export const quotaBuckets = (quota: AccountQuota) => {
  if (quota.buckets?.length) return quota.buckets;
  return [
    {
      id: "codex",
      name: null,
      primary: quota.primary,
      secondary: quota.secondary,
    },
  ];
};

export const quotaWindows = (quota: AccountQuota) =>
  quotaBuckets(quota).flatMap((bucket) =>
    [bucket.primary, bucket.secondary].filter((window): window is UsageWindow =>
      Boolean(window),
    ),
  );

export const quotaUtilization = (quota: AccountQuota) => {
  const windows = quotaWindows(quota);
  return windows.length
    ? Math.max(...windows.map((window) => window.usedPercent))
    : null;
};

export const quotaLevel = (quota: AccountQuota): QuotaLevel => {
  if (!quota.success) return "error";
  const utilization = quotaUtilization(quota);
  if (utilization === null) return "unknown";
  if (utilization >= 90) return "tight";
  if (utilization >= 70) return "attention";
  return "healthy";
};

export const levelLabel = (level: QuotaLevel, t: Translate) => {
  if (level === "healthy") return t("quotaHealthy");
  if (level === "attention") return t("quotaAttention");
  if (level === "tight") return t("quotaTight");
  if (level === "error") return t("quotaUnavailable");
  return t("quotaUnknown");
};

export const quotaEvents = (quotas: AccountQuota[], t: Translate) => {
  const now = Date.now() / 1000;
  const events: QuotaEvent[] = [];
  for (const quota of quotas) {
    for (const window of quotaWindows(quota)) {
      if (window.resetsAt && window.resetsAt > now) {
        events.push({
          accountId: quota.accountId,
          accountLabel: quota.label,
          at: window.resetsAt,
          detail: t("quotaWindowRecovers", {
            window: formatWindow(window.windowMinutes, t),
          }),
          kind: "reset",
        });
      }
    }
    for (const expiresAt of quota.resetCredits?.expiresAt ?? []) {
      if (expiresAt > now) {
        events.push({
          accountId: quota.accountId,
          accountLabel: quota.label,
          at: expiresAt,
          detail: t("resetCreditWillExpire"),
          kind: "expiry",
        });
      }
    }
  }
  return events.sort((left, right) => left.at - right.at);
};

export const formatPlan = (planType: string | null) => {
  if (!planType) return null;
  return planType
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
};

export const formatCount = (value: number | null, locale: Locale) =>
  value === null
    ? "—"
    : new Intl.NumberFormat(locale, { notation: "compact" }).format(value);

export const formatTokenUnit = (value: number, locale: Locale) => {
  const magnitude = Math.abs(value);
  const unit = TOKEN_UNITS.find((candidate) => magnitude >= candidate.minimum);
  if (!unit) return new Intl.NumberFormat(locale).format(value);

  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  }).format(value / unit.minimum)}${unit.suffix}`;
};

export const formatDuration = (seconds: number | null, t: Translate) => {
  if (seconds === null) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.max(1, Math.round((seconds % 3600) / 60));
  if (!hours) return t("minutesCount", { count: minutes });
  return t("hoursMinutes", { hours, minutes });
};

export const parseIsoDay = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
};

export const formatCalendarDay = (date: Date, locale: Locale) =>
  new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);

export const recentTokenUsage = (
  buckets: AccountUsageDailyBucket[],
  dayCount: number,
) => {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (dayCount - 1));

  let hasValidBucket = false;
  let tokens = 0;
  for (const bucket of buckets) {
    const date = parseIsoDay(bucket.startDate);
    if (!date || !Number.isFinite(bucket.tokens)) continue;
    hasValidBucket = true;
    if (date >= start && date <= end) {
      tokens += Math.max(0, bucket.tokens);
    }
  }

  return hasValidBucket ? { end, start, tokens } : null;
};
