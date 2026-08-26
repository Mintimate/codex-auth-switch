import { AppStatus } from "./api";
import { Translate } from "./i18n";

type AccountFlowProps = {
  activeLabel: string | null;
  status: AppStatus | null;
  t: Translate;
};

function FlowIcon({ kind }: { kind: "account" | "switch" | "file" | "codex" }) {
  if (kind === "account") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="8" r="3.4" />
        <path d="M5.7 19c.7-4 2.8-6 6.3-6s5.6 2 6.3 6" />
      </svg>
    );
  }
  if (kind === "switch") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 7h12M15 4l3 3-3 3M18 17H6M9 14l-3 3 3 3" />
      </svg>
    );
  }
  if (kind === "file") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 3.5h7l4 4V20H7zM14 3.5V8h4" />
        <path d="M10 12h5M10 15.5h5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.7 4.2a7.8 7.8 0 0 1 9.6 3.1M19.7 9.6a7.8 7.8 0 0 1-2.2 9.1M15.4 20.1a7.8 7.8 0 0 1-9.7-3M4.3 14.7A7.8 7.8 0 0 1 6.5 5.6" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

export function AccountFlow({ activeLabel, status, t }: AccountFlowProps) {
  const steps = [
    {
      detail: t("flowSavedDetail", { count: status?.accounts.length ?? 0 }),
      icon: "account" as const,
      label: t("flowSavedAccounts"),
    },
    {
      detail: t("flowSwitchDetail"),
      icon: "switch" as const,
      label: "Codex Auth Switch",
    },
    {
      detail: t("flowAuthFileDetail"),
      icon: "file" as const,
      label: "auth.json",
    },
    {
      detail: activeLabel ?? t("flowCodexDetail"),
      icon: "codex" as const,
      label: "Codex",
    },
  ];
  const connectors = [
    t("flowCaptureTokens"),
    t("flowAtomicReplace"),
    t("flowNextRequest"),
  ];

  return (
    <section
      className="account-flow-section"
      aria-labelledby="account-flow-title"
    >
      <div className="account-flow-heading">
        <div>
          <span className="eyebrow">{t("flowEyebrow")}</span>
          <h2 id="account-flow-title">{t("flowTitle")}</h2>
        </div>
        <p>{t("flowDescription")}</p>
      </div>

      <div className="account-flow" role="list">
        {steps.map((step, index) => (
          <div className="account-flow-fragment" key={step.label}>
            <div className="flow-step" role="listitem">
              <div className={`flow-icon ${step.icon}`}>
                <FlowIcon kind={step.icon} />
              </div>
              <strong>{step.label}</strong>
              <span>{step.detail}</span>
            </div>
            {index < connectors.length && (
              <div className="flow-connector" aria-hidden="true">
                <span className="flow-line" />
                <small>{connectors[index]}</small>
                <span className="flow-arrow">›</span>
              </div>
            )}
          </div>
        ))}
      </div>

      <p className="account-flow-note">{t("flowPrivacyNote")}</p>
    </section>
  );
}
