import { useCallback, useEffect, useId, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { clearQuotaHistory, getQuotaHistory } from "./api";
import type { QuotaHistory, QuotaPoint } from "./api";
import type { Locale, MessageKey, Translate } from "./i18n";
import { formatDate, formatWindow } from "./quotaView";
import { quotaChange } from "./quotaHistory";

const changeKeys: Record<ReturnType<typeof quotaChange>["kind"], MessageKey> = {
  first: "historyFirst",
  incomparable: "historyIncomparable",
  period: "historyPeriodChanged",
  recovered: "historyRecovered",
  increased: "historyIncreased",
  unchanged: "historyUnchanged",
};
const seriesKey = (p: QuotaPoint) => JSON.stringify([p.bucketId, p.window]);

export function QuotaHistoryPanel({
  profileId,
  revision,
  warning,
  queryFailed,
  refreshing,
  locale,
  t,
  onRefreshQuota,
}: {
  profileId: string;
  revision: number | undefined;
  warning?: string | null;
  queryFailed: boolean;
  refreshing: boolean;
  locale: Locale;
  t: Translate;
  onRefreshQuota: () => void;
}) {
  const [history, setHistory] = useState<QuotaHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [selected, setSelected] = useState("");
  const [days, setDays] = useState(1);
  const [limit, setLimit] = useState(20);
  const request = useRef(0);
  const id = useId();
  const load = useCallback(async () => {
    const sequence = ++request.current;
    setLoading(true);
    setError(false);
    try {
      const result = await getQuotaHistory();
      if (sequence === request.current) setHistory(result);
    } catch {
      if (sequence === request.current) setError(true);
    } finally {
      if (sequence === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      request.current += 1;
    };
  }, [load, revision, refreshing]);
  const clear = async () => {
    setClearing(true);
    request.current += 1;
    try {
      await clearQuotaHistory();
      setHistory(null);
      setConfirmClear(false);
      await load();
    } catch {
      setError(true);
    } finally {
      setClearing(false);
    }
  };
  const accountPoints = (history?.points ?? []).filter(
    (point) => point.profileId === profileId,
  );
  const series = [
    ...new Map(
      accountPoints.map((point) => [seriesKey(point), point]),
    ).entries(),
  ];
  const selection = series.some(([key]) => key === selected)
    ? selected
    : series[0]?.[0];
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const points = accountPoints
    .filter((p) => seriesKey(p) === selection && p.queriedAt >= since)
    .sort((a, b) => a.queriedAt - b.queriedAt);
  const latest = points.at(-1);
  const number = (n: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n);
  const changeText = (index: number) => {
    const change = quotaChange(points[index - 1], points[index]);
    return t(changeKeys[change.kind], {
      points: change.points === null ? "" : number(change.points),
    });
  };
  const x = (p: QuotaPoint) =>
    points.length < 2
      ? 310
      : 35 +
        ((p.queriedAt - points[0].queriedAt) /
          Math.max(
            1,
            points[points.length - 1].queriedAt - points[0].queriedAt,
          )) *
          550;
  const y = (p: QuotaPoint) => 20 + p.usedPercent * 1.5;
  return (
    <section
      className="quota-history-panel"
      aria-labelledby={`${id}-title`}
      aria-busy={loading || clearing}
    >
      <div className="observation-heading">
        <div>
          <h3 id={`${id}-title`}>{t("historyTitle")}</h3>
          <p>{t("historyDescription")}</p>
        </div>
        <button
          type="button"
          className="text-button"
          disabled={refreshing || clearing}
          onClick={onRefreshQuota}
        >
          <RefreshCw size={15} aria-hidden="true" />
          {t(refreshing ? "queryingQuota" : "historyTakeSnapshot")}
        </button>
      </div>
      {queryFailed && (
        <p className="usage-inline-error" role="status">
          {t("historyQueryFailed")}
        </p>
      )}
      {(warning || error) && (
        <div className="usage-inline-error" role="status">
          <span>{t(error ? "historyReadFailed" : "historyWriteFailed")}</span>
          <button
            type="button"
            disabled={loading || clearing}
            onClick={() => void load()}
          >
            {t("retry")}
          </button>
        </div>
      )}
      <div className="history-controls">
        <label>
          {t("historyWindow")}
          <select
            value={selection ?? ""}
            disabled={!series.length}
            onChange={(e) => {
              setSelected(e.target.value);
              setLimit(20);
            }}
          >
            {!series.length && (
              <option value="">{t("historyNoWindows")}</option>
            )}
            {series.map(([key, p]) => (
              <option key={key} value={key}>
                {p.bucketId} · {formatWindow(p.windowMinutes, t)} ·{" "}
                {t(
                  p.window === "primary"
                    ? "historyPrimary"
                    : "historySecondary",
                )}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("historyRange")}
          <select
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value));
              setLimit(20);
            }}
          >
            <option value={1}>{t("history24Hours")}</option>
            <option value={7}>{t("last7Days")}</option>
            <option value={30}>{t("last30Days")}</option>
          </select>
        </label>
      </div>
      {loading && !history ? (
        <p role="status">{t("historyLoading")}</p>
      ) : !points.length ? (
        <div className="history-empty">
          <strong>{t("historyEmpty")}</strong>
          <p>{t("historyEmptyHint")}</p>
        </div>
      ) : (
        <>
          <div className="history-summary">
            <div>
              <span>{t("historyLatestRemaining")}</span>
              <strong>{number(100 - latest!.usedPercent)}%</strong>
              <small>{formatDate(latest!.queriedAt, locale)}</small>
            </div>
            <div>
              <span>{t("historyLatestChange")}</span>
              <strong className="history-change-label">
                {changeText(points.length - 1)}
              </strong>
              <small>{t("historySampleCount", { count: points.length })}</small>
            </div>
          </div>
          <svg
            className="history-chart"
            viewBox="0 0 620 210"
            role="img"
            aria-labelledby={`${id}-chart-title ${id}-chart-desc`}
          >
            <title id={`${id}-chart-title`}>{t("historyChartTitle")}</title>
            <desc id={`${id}-chart-desc`}>{t("historyChartHint")}</desc>
            {[0, 50, 100].map((remaining) => (
              <g key={remaining}>
                <line
                  x1="35"
                  x2="585"
                  y1={170 - remaining * 1.5}
                  y2={170 - remaining * 1.5}
                  className="history-grid"
                />
                <text x="29" y={174 - remaining * 1.5} textAnchor="end">
                  {remaining}%
                </text>
              </g>
            ))}
            {points.map((p, index) => (
              <g key={`${p.queriedAt}-${index}`}>
                {index > 0 &&
                  quotaChange(points[index - 1], p).points !== null && (
                    <line
                      x1={x(points[index - 1])}
                      y1={y(points[index - 1])}
                      x2={x(p)}
                      y2={y(p)}
                      className="history-line"
                    />
                  )}
                <circle cx={x(p)} cy={y(p)} r="3" className="history-dot">
                  <title>
                    {formatDate(p.queriedAt, locale)} ·{" "}
                    {number(100 - p.usedPercent)}%
                  </title>
                </circle>
              </g>
            ))}
            <text x="35" y="200">
              {formatDate(points[0].queriedAt, locale)}
            </text>
            <text x="585" y="200" textAnchor="end">
              {formatDate(latest!.queriedAt, locale)}
            </text>
          </svg>
          <p className="observation-hint">{t("historyChartHint")}</p>
          <div
            className="history-table-scroll"
            role="region"
            aria-label={t("historyTitle")}
            tabIndex={0}
          >
            <table className="history-table">
              <thead>
                <tr>
                  <th>{t("historyObservedAt")}</th>
                  <th>{t("historyLatestRemaining")}</th>
                  <th>{t("historyChange")}</th>
                  <th>{t("historySource")}</th>
                </tr>
              </thead>
              <tbody>
                {points
                  .map((p, index) => ({ p, index }))
                  .reverse()
                  .slice(0, limit)
                  .map(({ p, index }) => (
                    <tr key={`${p.queriedAt}-${index}`}>
                      <td>{formatDate(p.queriedAt, locale)}</td>
                      <td>{number(100 - p.usedPercent)}%</td>
                      <td>{changeText(index)}</td>
                      <td>
                        {t(
                          p.source === "appServer"
                            ? "historyAppServer"
                            : "historyCompatibility",
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {points.length > limit && (
            <button
              type="button"
              className="text-button"
              onClick={() => setLimit((count) => count + 50)}
            >
              {t("historyShowMore")}
            </button>
          )}
        </>
      )}
      <p className="observation-hint">{t("historyRetention")}</p>
      <div className="observation-actions">
        {confirmClear ? (
          <>
            <span>{t("historyClearConfirm")}</span>
            <button
              type="button"
              className="text-button"
              disabled={clearing || refreshing || loading}
              onClick={() => void clear()}
            >
              {t("historyClearAll")}
            </button>
            <button
              type="button"
              className="text-button"
              disabled={clearing}
              onClick={() => setConfirmClear(false)}
            >
              {t("cancel")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="text-button"
            disabled={clearing || refreshing || loading}
            onClick={() => setConfirmClear(true)}
          >
            {t("historyClearAll")}
          </button>
        )}
      </div>
    </section>
  );
}
