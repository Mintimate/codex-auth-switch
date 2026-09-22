import type { AccountQuota, AccountUsageDailyBucket, UsageWindow } from "./api";
import type { Locale, Translate } from "./i18n";

export type QuotaLevel =
  "healthy" | "attention" | "tight" | "unknown" | "error";

export type QuotaDetailView = "quota" | "usage";

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

export const formatWindow = (
  minutes: number | null,
  t: Translate,
  compact = false,
) => {
  if (!minutes) return t("quotaWindow");
  if (minutes % 1440 === 0) {
    return t(compact ? "shortDaysWindow" : "daysWindow", {
      count: minutes / 1440,
    });
  }
  if (minutes % 60 === 0) {
    return t(compact ? "shortHoursWindow" : "hoursWindow", {
      count: minutes / 60,
    });
  }
  return t(compact ? "shortMinutesWindow" : "minutesWindow", {
    count: minutes,
  });
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

// 首页最多展示一个额度池，避免把不同模型的窗口混为同一份额度。
export const summaryQuotaBucket = (quota: AccountQuota | null) => {
  if (!quota?.success) return null;
  const buckets = quotaBuckets(quota).filter(
    (bucket) => bucket.primary || bucket.secondary,
  );
  return buckets.find((bucket) => bucket.id === "codex") ?? buckets[0] ?? null;
};

export const remainingQuotaPercent = (window: UsageWindow | null) => {
  if (!window || !Number.isFinite(window.usedPercent)) return null;
  return (
    Math.round(Math.min(100, Math.max(0, 100 - window.usedPercent)) * 10) / 10
  );
};

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

export const formatCount = (value: number | null, locale: Locale) => {
  if (value === null) return "—";
  if (locale === "zh-CN") {
    const magnitude = Math.abs(value);
    const numberFormatter = new Intl.NumberFormat(locale, {
      maximumFractionDigits: magnitude >= 100_000_000 ? 1 : 2,
    });
    if (magnitude >= 10_000_000) {
      return `${numberFormatter.format(value / 100_000_000)}亿`;
    }
    if (magnitude >= 10_000) {
      return `${numberFormatter.format(value / 10_000)}万`;
    }
  }
  return new Intl.NumberFormat(locale, { notation: "compact" }).format(value);
};

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

export const normalizeDailyUsage = (buckets: AccountUsageDailyBucket[]) => {
  const days = new Map<string, number>();
  for (const bucket of buckets) {
    if (!parseIsoDay(bucket.startDate) || !Number.isFinite(bucket.tokens))
      continue;
    // 同一天只保留最后一个有效记录，与日历和跨账号汇总保持一致。
    days.set(bucket.startDate, Math.max(0, bucket.tokens));
  }
  return days;
};

export const recentTokenUsage = (
  buckets: AccountUsageDailyBucket[],
  dayCount: number,
) => {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (dayCount - 1));

  const days = normalizeDailyUsage(buckets);
  let tokens = 0;
  for (const [day, count] of days) {
    const date = parseIsoDay(day)!;
    if (date >= start && date <= end) {
      tokens += count;
    }
  }

  return days.size ? { end, start, tokens } : null;
};

export const nextQuotaReset = (quota: AccountQuota | null) => {
  if (!quota?.success) return null;
  const futureResets = quotaWindows(quota)
    .map((window) => window.resetsAt)
    .filter((at): at is number => at !== null && at > Date.now() / 1000);
  return futureResets.length ? Math.min(...futureResets) : null;
};

export const compareQuotaNumbers = (
  left: number | null,
  right: number | null,
  descending = false,
) => {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return descending ? right - left : left - right;
};

const latestSuccessfulQuotas = (quotas: AccountQuota[]) => {
  // 同一订阅的多个本地档案只统计一次，优先使用最近的成功结果。
  const byAccount = new Map<string, AccountQuota>();
  for (const quota of quotas) {
    if (!quota.success) continue;
    const previous = byAccount.get(quota.accountId);
    if (!previous || quota.queriedAt > previous.queriedAt) {
      byAccount.set(quota.accountId, quota);
    }
  }
  return [...byAccount.values()];
};

export const aggregateDailyUsage = (quotas: AccountQuota[]) => {
  const totals = new Map<string, number>();
  let accountCount = 0;
  for (const quota of latestSuccessfulQuotas(quotas)) {
    const days = normalizeDailyUsage(
      quota.officialUsage?.dailyUsageBuckets ?? [],
    );
    if (days.size) accountCount += 1;
    for (const [date, tokens] of days) {
      totals.set(date, (totals.get(date) ?? 0) + tokens);
    }
  }
  return {
    accountCount,
    buckets: [...totals]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([startDate, tokens]) => ({ startDate, tokens })),
  };
};

export const summarizeQuotas = (quotas: AccountQuota[]) => {
  const successful = latestSuccessfulQuotas(quotas);
  const sumRecent = (days: number) => {
    const values = successful.flatMap((quota) => {
      const usage = quota.officialUsage
        ? recentTokenUsage(quota.officialUsage.dailyUsageBuckets, days)
        : null;
      return usage ? [usage.tokens] : [];
    });
    return {
      tokens: values.length
        ? values.reduce((sum, value) => sum + value, 0)
        : null,
      count: values.length,
    };
  };
  const credits = successful.flatMap((quota) =>
    quota.resetCredits ? [quota.resetCredits.availableCount] : [],
  );
  return {
    successful: successful.length,
    sevenDays: sumRecent(7),
    thirtyDays: sumRecent(30),
    credits: credits.length
      ? credits.reduce((sum, count) => sum + count, 0)
      : null,
    creditAccounts: credits.length,
  };
};
