import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleHelp,
  ChevronDown,
  RefreshCw,
  X,
} from "lucide-react";
import { verifyAccountSwitch } from "./api";
import type {
  AppStatus,
  SwitchResult,
  SwitchStage,
  SwitchVerification,
} from "./api";
import type { Locale, MessageKey, Translate } from "./i18n";
import { formatDate } from "./quotaView";
import { redactEmails } from "./privacy";

export type SwitchReport = {
  profileId: string;
  restart: SwitchResult["restart"] | "failed";
  failedStage?: SwitchStage;
};

const fileKeys: Record<SwitchVerification["credentialFile"], MessageKey> = {
  matched: "switchFileMatched",
  different: "switchFileDifferent",
  unavailable: "switchFileUnavailable",
  unsupported: "switchFileUnsupported",
  pendingLogin: "switchFilePending",
  targetRemoved: "switchTargetRemoved",
};
const desktopKeys: Record<SwitchVerification["desktop"], MessageKey> = {
  running: "switchDesktopRunning",
  notRunning: "switchDesktopStopped",
  unsupported: "switchDesktopUnsupported",
  unavailable: "switchDesktopUnknown",
};
const outcomeKeys: Record<SwitchReport["restart"], MessageKey> = {
  restarted: "switchOutcomeRestarted",
  notRequested: "switchOutcomeManual",
  notRunning: "switchOutcomeStopped",
  launchFailed: "switchOutcomeLaunchFailed",
  failed: "switchOutcomeFailed",
};
const stageKeys: Record<SwitchStage, MessageKey> = {
  checking: "switchProgressChecking",
  closing: "switchProgressClosing",
  switching: "switchProgressWriting",
  launching: "switchProgressLaunching",
};

export function SwitchResultPanel({
  report,
  status,
  busy,
  privateMode,
  locale,
  t,
  onRetry,
  onDismiss,
}: {
  report: SwitchReport;
  status: AppStatus | null;
  busy: boolean;
  privateMode: boolean;
  locale: Locale;
  t: Translate;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const [verification, setVerification] = useState<SwitchVerification | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const request = useRef(0);
  const check = useCallback(async () => {
    const id = ++request.current;
    setChecking(true);
    setFailed(false);
    setVerification(null);
    try {
      const result = await verifyAccountSwitch(report.profileId);
      if (id === request.current) setVerification(result);
    } catch {
      if (id === request.current) setFailed(true);
    } finally {
      if (id === request.current) setChecking(false);
    }
  }, [report.profileId]);
  useEffect(() => {
    void check();
    return () => {
      request.current += 1;
    };
  }, [check, report, status]);
  const target = status?.accounts.find(
    (account) => account.id === report.profileId,
  );
  const label = target
    ? privateMode
      ? redactEmails(target.label, t("emailHidden"))
      : target.label
    : t("switchTargetRemoved");
  const matched = verification?.credentialFile === "matched";
  const needsAttention =
    report.restart === "failed" ||
    report.restart === "launchFailed" ||
    (report.restart === "restarted" &&
      verification?.desktop === "notRunning") ||
    failed ||
    (verification !== null && !matched);
  const verificationWarning =
    verification && !matched
      ? t(fileKeys[verification.credentialFile])
      : failed
        ? t("switchCheckFailed")
        : report.restart === "restarted" &&
            verification?.desktop === "notRunning"
          ? t("switchDesktopStopped")
          : null;
  return (
    <section
      className="switch-result-panel"
      aria-label={t("switchResultTitle")}
      aria-busy={checking}
    >
      <div className="switch-result-summary">
        {needsAttention ? (
          <CircleHelp size={18} aria-hidden="true" />
        ) : (
          <CheckCircle2
            size={18}
            className="observation-success"
            aria-hidden="true"
          />
        )}
        <div className="switch-result-message" role="status" aria-live="polite">
          <span>{t(outcomeKeys[report.restart], { account: label })}</span>
          {verificationWarning && <small>{verificationWarning}</small>}
        </div>
        <button
          type="button"
          className="text-button switch-result-toggle"
          aria-expanded={expanded}
          aria-controls="switch-result-details"
          onClick={() => setExpanded((value) => !value)}
        >
          {t("switchResultDetails")}
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="quota-icon-button"
          onClick={onDismiss}
          aria-label={t("close")}
        >
          <X size={16} />
        </button>
      </div>
      <div
        id="switch-result-details"
        className="switch-result-details"
        hidden={!expanded}
      >
        {report.failedStage && <p>{t(stageKeys[report.failedStage])}</p>}
        <dl>
          <div>
            <dt>{t("switchCredentialCheck")}</dt>
            <dd>
              {verification
                ? t(fileKeys[verification.credentialFile])
                : t(checking ? "switchCheckingResult" : "switchCheckFailed")}
            </dd>
          </div>
          <div>
            <dt>{t("switchClientCheck")}</dt>
            <dd>
              {verification
                ? t(desktopKeys[verification.desktop])
                : t(checking ? "switchCheckingResult" : "switchCheckFailed")}
            </dd>
          </div>
        </dl>
        <p className="switch-result-hint">{t("switchIdentityUnconfirmed")}</p>
        <div className="observation-actions">
          <button
            type="button"
            className="text-button switch-result-recheck"
            disabled={checking || busy}
            onClick={() => void check()}
          >
            <RefreshCw size={15} aria-hidden="true" />
            {t("switchRecheck")}
          </button>
          {target &&
            (report.restart === "failed" ||
              report.restart === "launchFailed" ||
              (verification && !matched)) && (
              <button
                type="button"
                className="text-button"
                disabled={checking || busy || !status?.supported}
                onClick={onRetry}
              >
                {t("switchRetry")}
              </button>
            )}
          {verification && (
            <small>
              {t("switchCheckedAt", {
                time: formatDate(verification.checkedAt, locale),
              })}
            </small>
          )}
        </div>
      </div>
    </section>
  );
}
