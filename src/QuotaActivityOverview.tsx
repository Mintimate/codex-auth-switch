import { useState } from "react";
import type { AccountQuota, AccountSummary } from "./api";
import type { Locale, Translate } from "./i18n";
import { DailyUsageHeatmap } from "./DailyUsageHeatmap";
import { aggregateDailyUsage } from "./quotaView";

type Props = {
  accounts: AccountSummary[];
  quotas: AccountQuota[];
  displayLabel: (label: string) => string;
  locale: Locale;
  t: Translate;
};

export function QuotaActivityOverview({
  accounts,
  quotas,
  displayLabel,
  locale,
  t,
}: Props) {
  const [profileId, setProfileId] = useState("");
  const selectedId = accounts.some((account) => account.id === profileId)
    ? profileId
    : "";
  const { buckets, accountCount } = aggregateDailyUsage(
    selectedId
      ? quotas.filter((quota) => quota.profileId === selectedId)
      : quotas,
  );
  const total = selectedId
    ? 1
    : new Set(accounts.map((account) => account.accountId)).size;
  const selector = (
    <select
      aria-label={t("quotaActivityScope")}
      value={selectedId}
      onChange={(event) => setProfileId(event.target.value)}
    >
      <option value="">{t("quotaActivityAllAccounts")}</option>
      {accounts.map((account) => (
        <option key={account.id} value={account.id}>
          {displayLabel(account.label)}
        </option>
      ))}
    </select>
  );

  return (
    <section
      className="quota-activity-overview"
      aria-label={t("dailyTokenActivity")}
    >
      {buckets.length ? (
        <DailyUsageHeatmap
          buckets={buckets}
          locale={locale}
          t={t}
          controls={selector}
        />
      ) : (
        <>
          <div className="quota-daily-usage-heading">
            <strong>{t("dailyTokenActivity")}</strong>
            {selector}
          </div>
          <p className="quota-activity-empty" role="status">
            {t("noDailyTokenUsage")}
          </p>
        </>
      )}
      <p className="quota-activity-coverage">
        {t("quotaUsageCoverage", { count: accountCount, total })}
      </p>
    </section>
  );
}
