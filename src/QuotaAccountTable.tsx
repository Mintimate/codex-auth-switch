import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  History,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type { AccountQuota, AccountSummary } from "./api";
import type { Locale, Translate } from "./i18n";
import type { QuotaDetailView } from "./quotaView";
import {
  compareQuotaNumbers,
  formatCount,
  formatDate,
  formatPlan,
  formatRelative,
  levelLabel,
  nextQuotaReset,
  quotaLevel,
  quotaUtilization,
  recentTokenUsage,
} from "./quotaView";

type Props = {
  accounts: AccountSummary[];
  activeAccountId: string | null;
  quotas: AccountQuota[];
  refreshingIds: string[];
  refreshErrors: Record<string, string>;
  displayLabel: (label: string) => string;
  onRefresh: (id: string) => void;
  onDetails: (id: string, view: QuotaDetailView) => void;
  locale: Locale;
  t: Translate;
};

type Filter = "all" | "healthy" | "attention" | "unavailable";
type Sort =
  "default" | "available" | "recovery" | "sevenDays" | "thirtyDays" | "credits";
const PAGE_SIZE = 8;

export function QuotaAccountTable({
  accounts,
  activeAccountId,
  quotas,
  refreshingIds,
  refreshErrors,
  displayLabel,
  onRefresh,
  onDetails,
  locale,
  t,
}: Props) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("default");
  const [page, setPage] = useState(0);
  const byProfile = new Map(quotas.map((quota) => [quota.profileId, quota]));
  const rows = accounts.map((account) => {
    const quota = byProfile.get(account.id) ?? null;
    const usage = quota?.success ? quota.officialUsage : null;
    return {
      account,
      quota,
      level: quota ? quotaLevel(quota) : ("unknown" as const),
      utilization: quota?.success ? quotaUtilization(quota) : null,
      recovery: nextQuotaReset(quota),
      sevenDays: usage
        ? (recentTokenUsage(usage.dailyUsageBuckets, 7)?.tokens ?? null)
        : null,
      thirtyDays: usage
        ? (recentTokenUsage(usage.dailyUsageBuckets, 30)?.tokens ?? null)
        : null,
      credits: quota?.success
        ? (quota.resetCredits?.availableCount ?? null)
        : null,
    };
  });
  const matchesFilter = (row: (typeof rows)[number], value: Filter) => {
    if (value === "all") return true;
    if (value === "attention")
      return row.level === "attention" || row.level === "tight";
    if (value === "unavailable")
      return row.level === "error" || row.level === "unknown";
    return row.level === value;
  };
  const query = search.trim().toLocaleLowerCase(locale);
  const filtered = rows
    .filter(
      (row) =>
        matchesFilter(row, filter) &&
        `${displayLabel(row.account.label)} ${formatPlan(row.quota?.planType ?? null) ?? ""}`
          .toLocaleLowerCase(locale)
          .includes(query),
    )
    .sort((left, right) => {
      const activeFirst =
        Number(right.account.accountId === activeAccountId) -
        Number(left.account.accountId === activeAccountId);
      if (sort === "default") return activeFirst;
      if (sort === "available")
        return compareQuotaNumbers(left.utilization, right.utilization);
      if (sort === "recovery")
        return compareQuotaNumbers(left.recovery, right.recovery);
      return compareQuotaNumbers(left[sort], right[sort], true);
    });
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );
  const filters = [
    { value: "all", label: "quotaAllAccounts" },
    { value: "healthy", label: "quotaHealthy" },
    { value: "attention", label: "quotaNeedsAttention" },
    { value: "unavailable", label: "quotaNoData" },
  ] as const;

  return (
    <section className="quota-comparison" aria-label={t("accountQuotaStatus")}>
      <div className="quota-table-toolbar">
        <h3>{t("accountQuotaStatus")}</h3>
        <div className="quota-table-tools">
          <div className="quota-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              aria-label={t("quotaSearchAccounts")}
              placeholder={t("quotaSearchAccounts")}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
            {search && (
              <button
                type="button"
                className="quota-icon-button"
                title={t("quotaClearSearch")}
                aria-label={t("quotaClearSearch")}
                onClick={() => {
                  setSearch("");
                  setPage(0);
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>
          <select
            aria-label={t("quotaSortAccounts")}
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as Sort);
              setPage(0);
            }}
          >
            <option value="default">{t("quotaSortDefault")}</option>
            <option value="available">{t("quotaSortAvailable")}</option>
            <option value="recovery">{t("quotaSortRecovery")}</option>
            <option value="sevenDays">{t("quotaSortSevenDays")}</option>
            <option value="thirtyDays">{t("quotaSortThirtyDays")}</option>
            <option value="credits">{t("quotaSortCredits")}</option>
          </select>
        </div>
      </div>
      <div
        className="quota-filter-bar"
        role="group"
        aria-label={t("quotaFilterAccounts")}
      >
        {filters.map((item) => (
          <button
            type="button"
            key={item.value}
            aria-pressed={filter === item.value}
            onClick={() => {
              setFilter(item.value);
              setPage(0);
            }}
          >
            {t(item.label)}{" "}
            <span>
              {rows.filter((row) => matchesFilter(row, item.value)).length}
            </span>
          </button>
        ))}
      </div>
      <div
        className="quota-table-scroll"
        tabIndex={0}
        role="region"
        aria-label={t("accountQuotaStatus")}
      >
        <table className="quota-comparison-table">
          <thead>
            <tr>
              <th scope="col">{t("quotaAccountColumn")}</th>
              <th scope="col">{t("quotaHighestUsage")}</th>
              <th scope="col">{t("nextQuotaRecovery")}</th>
              <th scope="col">{t("last7DaysTokens")}</th>
              <th scope="col">{t("last30DaysTokens")}</th>
              <th scope="col">{t("quotaResetColumn")}</th>
              <th scope="col">
                <span className="quota-sr-only">{t("quotaActionsColumn")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const { account, quota, level } = row;
              const label = displayLabel(account.label);
              const refreshing = refreshingIds.includes(account.id);
              const refreshFailed = Boolean(refreshErrors[account.id]);
              return (
                <tr
                  key={account.id}
                  className={`level-${level}${account.accountId === activeAccountId ? " is-current" : ""}`}
                  aria-busy={refreshing}
                >
                  <th scope="row">
                    <button
                      type="button"
                      className="quota-account-link"
                      onClick={() => onDetails(account.id, "quota")}
                      title={label}
                    >
                      {label}
                    </button>
                    <div className="quota-row-meta">
                      {account.accountId === activeAccountId && (
                        <span className="quota-current-marker">
                          {t("currentAccount")}
                        </span>
                      )}
                      <span>
                        {formatPlan(quota?.planType ?? null) ?? t("unknown")}
                      </span>
                      <span className={`quota-status level-${level}`}>
                        {levelLabel(level, t)}
                      </span>
                    </div>
                    {(refreshing || refreshFailed) && (
                      <small
                        className={
                          refreshFailed && !refreshing ? "quota-row-error" : ""
                        }
                      >
                        {refreshing
                          ? t("queryingQuota")
                          : quota?.success
                            ? t("quotaCachedResult")
                            : t("quotaQueryFailed")}
                      </small>
                    )}
                    {quota?.historyWarning && (
                      <small className="quota-row-error">
                        {t("historyWriteFailed")}
                      </small>
                    )}
                  </th>
                  <td>
                    <strong className="quota-table-number">
                      {row.utilization === null
                        ? "—"
                        : `${Math.round(row.utilization * 10) / 10}%`}
                    </strong>
                    {row.utilization !== null && (
                      <div
                        className="quota-track"
                        role="progressbar"
                        aria-label={t("quotaHighestUsage")}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.min(
                          100,
                          Math.max(0, row.utilization),
                        )}
                      >
                        <span
                          style={{
                            width: `${Math.min(100, Math.max(0, row.utilization))}%`,
                          }}
                        />
                      </div>
                    )}
                  </td>
                  <td>
                    {row.recovery === null ? (
                      "—"
                    ) : (
                      <>
                        <span>{formatRelative(row.recovery, locale)}</span>
                        <small>{formatDate(row.recovery, locale)}</small>
                      </>
                    )}
                  </td>
                  {[row.sevenDays, row.thirtyDays].map((value, index) => (
                    <td key={index}>
                      <button
                        type="button"
                        className="quota-number-link"
                        onClick={() => onDetails(account.id, "usage")}
                        aria-label={t("quotaViewAccountUsage", {
                          account: label,
                        })}
                        title={
                          value === null
                            ? t("noDailyTokenUsage")
                            : new Intl.NumberFormat(locale).format(value)
                        }
                      >
                        {formatCount(value, locale)}
                      </button>
                    </td>
                  ))}
                  <td className="quota-table-number">
                    {row.credits === null
                      ? "—"
                      : t("resetCreditCount", { count: row.credits })}
                  </td>
                  <td>
                    <div className="quota-row-actions">
                      <button
                        type="button"
                        className="quota-icon-button"
                        disabled={refreshing}
                        onClick={() => onRefresh(account.id)}
                        title={t("refreshAccountQuota")}
                        aria-label={t("refreshAccountQuotaLabel", {
                          account: label,
                        })}
                      >
                        <RefreshCw
                          size={16}
                          className={refreshing ? "quota-icon-spinning" : ""}
                          aria-hidden="true"
                        />
                      </button>
                      <button
                        type="button"
                        className="quota-icon-button"
                        onClick={() => onDetails(account.id, "history")}
                        title={t("historyTitle")}
                        aria-label={t("historyAccountAction", {
                          account: label,
                        })}
                      >
                        <History size={16} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="quota-icon-button"
                        onClick={() => onDetails(account.id, "quota")}
                        title={t("quotaViewDetails")}
                        aria-label={t("quotaViewAccountDetails", {
                          account: label,
                        })}
                      >
                        <Eye size={16} aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!filtered.length && (
          <div className="quota-table-empty">
            <p>{t("quotaNoMatchingAccounts")}</p>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setSearch("");
                setFilter("all");
                setPage(0);
              }}
            >
              {t("quotaClearFilters")}
            </button>
          </div>
        )}
      </div>
      <div className="quota-table-footer">
        <span role="status">
          {t("quotaMatchingCount", {
            count: filtered.length,
            total: accounts.length,
          })}
        </span>
        {pageCount > 1 && (
          <nav aria-label={t("quotaPagination")}>
            <button
              type="button"
              className="quota-icon-button"
              disabled={currentPage === 0}
              title={t("quotaPreviousPage")}
              aria-label={t("quotaPreviousPage")}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <span>
              {currentPage + 1} / {pageCount}
            </span>
            <button
              type="button"
              className="quota-icon-button"
              disabled={currentPage === pageCount - 1}
              title={t("quotaNextPage")}
              aria-label={t("quotaNextPage")}
              onClick={() => setPage(currentPage + 1)}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </nav>
        )}
      </div>
    </section>
  );
}
