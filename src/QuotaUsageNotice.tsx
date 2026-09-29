import type { AccountQuota } from "./api";
import type { Locale, Translate } from "./i18n";
import { formatDate, summarizeUsageFreshness } from "./quotaView";

export function QuotaUsageNotice({
  quotas,
  locale,
  t,
}: {
  quotas: AccountQuota[];
  locale: Locale;
  t: Translate;
}) {
  const freshness = summarizeUsageFreshness(quotas);
  if (!freshness.warningAccounts) return null;

  return (
    <p className="alert warning" role="status">
      <span>
        {t("quotaUsagePartialUpdate", { count: freshness.warningAccounts })}{" "}
        {freshness.cachedAccounts > 0 && (
          <>
            {t("quotaUsageIncludesCached", {
              count: freshness.cachedAccounts,
            })}{" "}
            {freshness.oldestCachedAt !== null &&
              t("quotaUsageOldestCache", {
                date: formatDate(freshness.oldestCachedAt, locale, true),
              })}{" "}
            {freshness.hasUnknownCacheTime && t("quotaUsageCacheTimeUnknown")}
          </>
        )}
      </span>
    </p>
  );
}
