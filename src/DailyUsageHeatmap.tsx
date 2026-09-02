import { AccountUsageDailyBucket } from "./api";
import { Locale, Translate } from "./i18n";
import { formatCalendarDay, formatTokenUnit, parseIsoDay } from "./quotaView";

type DailyUsageHeatmapProps = {
  buckets: AccountUsageDailyBucket[];
  locale: Locale;
  t: Translate;
};

export function DailyUsageHeatmap({
  buckets,
  locale,
  t,
}: DailyUsageHeatmapProps) {
  const usageByDate = new Map<string, number>();
  for (const bucket of buckets) {
    if (!parseIsoDay(bucket.startDate) || !Number.isFinite(bucket.tokens)) {
      continue;
    }
    usageByDate.set(bucket.startDate, Math.max(0, bucket.tokens));
  }

  const dates = [...usageByDate.keys()].sort();
  const lastUsageDate = dates.at(-1) ? parseIsoDay(dates.at(-1)!) : null;
  if (!lastUsageDate) return null;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const rangeEnd = new Date(Math.max(today.getTime(), lastUsageDate.getTime()));
  const rangeStart = new Date(rangeEnd);
  rangeStart.setUTCDate(rangeStart.getUTCDate() - 364);

  const gridStart = new Date(rangeStart);
  gridStart.setUTCDate(gridStart.getUTCDate() - gridStart.getUTCDay());
  const gridEnd = new Date(rangeEnd);
  gridEnd.setUTCDate(gridEnd.getUTCDate() + (6 - gridEnd.getUTCDay()));

  const calendarDays: Date[] = [];
  for (
    const date = new Date(gridStart);
    date <= gridEnd;
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    calendarDays.push(new Date(date));
  }

  const numberFormatter = new Intl.NumberFormat(locale);
  const visibleUsage = [...usageByDate.entries()].filter(([dateKey]) => {
    const date = parseIsoDay(dateKey)!;
    return date >= rangeStart && date <= rangeEnd;
  });
  const maxTokens = Math.max(...visibleUsage.map(([, tokens]) => tokens), 0);
  const activeDayCount = visibleUsage.filter(([, tokens]) => tokens > 0).length;
  const weekdayFormatter = new Intl.DateTimeFormat(locale, {
    weekday: "narrow",
    timeZone: "UTC",
  });
  const monthFormatter = new Intl.DateTimeFormat(locale, {
    month: "short",
    timeZone: "UTC",
  });
  const weekCount = Math.ceil(calendarDays.length / 7);
  const monthLabels: { column: number; label: string }[] = [];
  for (const date of calendarDays) {
    const isFirstRangeDay = date.getTime() === rangeStart.getTime();
    if (
      date < rangeStart ||
      date > rangeEnd ||
      (!isFirstRangeDay && date.getUTCDate() !== 1)
    ) {
      continue;
    }
    const column = Math.floor(
      (date.getTime() - gridStart.getTime()) / (7 * 24 * 60 * 60 * 1000),
    );
    if (
      monthLabels.length &&
      column - monthLabels[monthLabels.length - 1].column < 2
    ) {
      monthLabels.pop();
    }
    monthLabels.push({
      column,
      label: monthFormatter.format(date),
    });
  }
  const activityLevel = (tokens: number) =>
    tokens <= 0 || maxTokens <= 0
      ? 0
      : Math.max(1, Math.min(4, Math.ceil((tokens / maxTokens) * 4)));

  return (
    <div className="quota-daily-usage">
      <div className="quota-daily-usage-heading">
        <strong>{t("dailyTokenActivity")}</strong>
        <span>
          {t("dailyUsageRange", {
            start: formatCalendarDay(rangeStart, locale),
            end: formatCalendarDay(rangeEnd, locale),
          })}
        </span>
      </div>
      <div className="quota-heatmap-scroll">
        <div className="quota-heatmap-layout">
          <div
            className="quota-heatmap-months"
            aria-hidden="true"
            style={{
              gridTemplateColumns: `repeat(${weekCount}, var(--heatmap-cell-size))`,
            }}
          >
            {monthLabels.map((month) => (
              <span
                key={`${month.column}-${month.label}`}
                style={{ gridColumn: month.column + 1 }}
              >
                {month.label}
              </span>
            ))}
          </div>
          <div className="quota-heatmap-weekdays" aria-hidden="true">
            {[1, 3, 5].map((weekday) => (
              <span key={weekday} style={{ gridRow: weekday + 1 }}>
                {weekdayFormatter.format(
                  new Date(Date.UTC(2026, 7, 2 + weekday)),
                )}
              </span>
            ))}
          </div>
          <div
            className="quota-heatmap-grid"
            role="grid"
            aria-label={t("dailyTokenActivityAria")}
            style={{
              gridTemplateColumns: `repeat(${weekCount}, var(--heatmap-cell-size))`,
            }}
          >
            {calendarDays.map((date, index) => {
              const dateKey = date.toISOString().slice(0, 10);
              const tokens = usageByDate.get(dateKey);
              const tooltip =
                tokens === undefined
                  ? undefined
                  : t("dailyTokenTooltip", {
                      date: formatCalendarDay(date, locale),
                      tokens: formatTokenUnit(tokens, locale),
                    });
              const ariaLabel =
                tokens === undefined
                  ? undefined
                  : t("dailyTokenTooltip", {
                      date: formatCalendarDay(date, locale),
                      tokens: numberFormatter.format(tokens),
                    });
              return (
                <span
                  className={`quota-heatmap-day${
                    tokens === undefined
                      ? " is-empty"
                      : ` level-${activityLevel(tokens)}`
                  }`}
                  key={dateKey}
                  data-tooltip={tooltip}
                  style={{
                    gridColumn: Math.floor(index / 7) + 1,
                    gridRow: (index % 7) + 1,
                  }}
                  aria-label={ariaLabel}
                  aria-hidden={tokens === undefined}
                  tabIndex={tokens === undefined ? -1 : 0}
                  role={tokens === undefined ? undefined : "gridcell"}
                />
              );
            })}
          </div>
        </div>
      </div>
      <div className="quota-heatmap-footer">
        <span className="quota-heatmap-summary">
          {t("dailyActivitySummary", {
            active: activeDayCount,
            recorded: visibleUsage.length,
          })}
        </span>
        <div className="quota-heatmap-legend" aria-hidden="true">
          <span>{t("usageLess")}</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <i className={`level-${level}`} key={level} />
          ))}
          <span>{t("usageMore")}</span>
        </div>
      </div>
    </div>
  );
}
