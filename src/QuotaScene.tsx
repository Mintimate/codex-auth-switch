import { SceneCat } from "./SceneCat";
import type { Translate } from "./i18n";

type QuotaSceneLevel = "healthy" | "attention" | "tight" | "unknown";

type QuotaSceneProps = {
  accountLabel: string;
  credits: number;
  level: QuotaSceneLevel;
  recoveryLabel: string;
  t: Translate;
  utilization: number | null;
};

function AccountStation() {
  return (
    <span className="quota-scene-account-icon" aria-hidden="true">
      <i />
      <b />
    </span>
  );
}

function RecoveryClock() {
  return (
    <span className="quota-scene-clock" aria-hidden="true">
      <i />
      <b />
    </span>
  );
}

function CreditTickets({ count }: { count: number }) {
  const visibleCount = Math.min(3, Math.max(1, count));
  return (
    <span
      className={`quota-scene-tickets${count ? " has-credits" : ""}`}
      aria-hidden="true"
    >
      {Array.from({ length: visibleCount }, (_, index) => (
        <i key={index} />
      ))}
    </span>
  );
}

export function QuotaScene({
  accountLabel,
  credits,
  level,
  recoveryLabel,
  t,
  utilization,
}: QuotaSceneProps) {
  const percent = utilization === null ? null : Math.round(utilization);
  const safePercent = Math.min(100, Math.max(0, percent ?? 0));
  const percentLabel = percent === null ? t("quotaUnknown") : `${safePercent}%`;

  return (
    <section
      className={`quota-supply-scene level-${level}`}
      role="img"
      aria-label={t("quotaSceneAria", {
        account: accountLabel,
        credits,
        percent: percentLabel,
        recovery: recoveryLabel,
      })}
    >
      <div className="quota-scene-stage" aria-hidden="true">
        <span className="quota-scene-route">
          <i />
        </span>

        <div className="quota-scene-station account-station">
          <span className="quota-scene-node">
            <AccountStation />
          </span>
          <strong>{t("quotaSceneCurrent")}</strong>
          <small>{accountLabel}</small>
        </div>

        <div className="quota-scene-station window-station">
          <span className="quota-scene-node quota-scene-meter">
            <i style={{ width: `${safePercent}%` }} />
            <b>{percentLabel}</b>
          </span>
          <strong>{t("quotaSceneWindow")}</strong>
          <small>{percentLabel}</small>
        </div>

        <div className="quota-scene-station recovery-station">
          <span className="quota-scene-node">
            <RecoveryClock />
          </span>
          <strong>{t("quotaSceneRecovery")}</strong>
          <small>{recoveryLabel}</small>
        </div>

        <div className="quota-scene-station credit-station">
          <span className="quota-scene-node">
            <CreditTickets count={credits} />
          </span>
          <strong>{t("quotaSceneCredits")}</strong>
          <small>{t("resetCreditCount", { count: credits })}</small>
        </div>

        <div className="quota-scene-runner">
          <span className="quota-scene-supply" />
          <SceneCat className="quota-scene-cat" />
        </div>
      </div>
      <span className="quota-scene-status" aria-hidden="true">
        {t("quotaSceneReady")}
      </span>
    </section>
  );
}
