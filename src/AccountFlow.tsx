import { AppStatus } from "./api";
import { Translate } from "./i18n";
import { SceneCat } from "./SceneCat";

type AccountFlowProps = {
  activeLabel: string | null;
  status: AppStatus | null;
  t: Translate;
};

type FlowIconKind =
  "account" | "switch" | "pairing" | "browser" | "file" | "codex";

function FlowIcon({ kind }: { kind: FlowIconKind }) {
  if (kind === "account") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="8" r="3.4" />
        <path d="M5.7 19c.7-4 2.8-6 6.3-6s5.6 2 6.3 6" />
      </svg>
    );
  }
  if (kind === "pairing") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
        <path d="M7 9.2h.1M10.3 9.2h.1M7 13h4M14.5 12l2 1.7-2 1.7" />
      </svg>
    );
  }
  if (kind === "browser") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <path d="M3 8h18M7 6h.1M10 6h.1M8 14l2.3 2.2L16.5 11" />
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

function FlowArrow() {
  return (
    <svg className="flow-arrow" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 8h11M9.5 4.5 13 8l-3.5 3.5" />
    </svg>
  );
}

function FlowConnector({ label }: { label: string }) {
  return (
    <div className="flow-connector" aria-hidden="true">
      <span className="flow-track">
        <span className="flow-line" />
        <FlowArrow />
      </span>
      <small>{label}</small>
    </div>
  );
}

function AccountSwitchScene({
  activeLabel,
  t,
}: {
  activeLabel: string | null;
  t: Translate;
}) {
  return (
    <div
      className="account-switch-scene"
      role="img"
      aria-label={t("switchSceneAria")}
    >
      <div className="account-switch-stage" aria-hidden="true">
        <div className="account-switch-source">
          <span className="account-switch-scene-icon">
            <FlowIcon kind="account" />
          </span>
          <strong>{t("switchSceneSaved")}</strong>
          <small>{activeLabel ?? t("flowSavedAccounts")}</small>
        </div>

        <div className="account-switch-route" />

        <span className="account-switch-hub">
          <FlowIcon kind="switch" />
          <small>{t("switchSceneSwitching")}</small>
        </span>

        <div className="account-switch-target">
          <span className="scene-check">✓</span>
          <strong>Codex</strong>
          <small>{t("switchSceneComplete")}</small>
        </div>

        <div className="account-switch-runner">
          <span className="account-switch-file">auth.json</span>
          <SceneCat className="account-switch-cat" />
        </div>
      </div>

      <div className="account-switch-scene-steps" aria-hidden="true">
        <span>{t("switchSceneStepSelect")}</span>
        <span>{t("switchSceneStepReplace")}</span>
        <span>{t("switchSceneStepReady")}</span>
      </div>
    </div>
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

      <AccountSwitchScene activeLabel={activeLabel} t={t} />

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
              <FlowConnector label={connectors[index]} />
            )}
          </div>
        ))}
      </div>

      <p className="account-flow-note">{t("flowPrivacyNote")}</p>
    </section>
  );
}

function OAuthCatScene({ t }: { t: Translate }) {
  return (
    <div className="oauth-scene" role="img" aria-label={t("loginSceneAria")}>
      <div className="oauth-scene-stage" aria-hidden="true">
        <div className="oauth-scene-browser">
          <span className="scene-browser-bar">
            <i />
            <i />
            <i />
          </span>
          <strong>{t("loginSceneBrowser")}</strong>
          <span className="scene-code">ABCD-EFGH</span>
        </div>

        <div className="oauth-scene-route">
          <span className="scene-packet">•••</span>
        </div>

        <div className="oauth-scene-account">
          <span className="scene-check">✓</span>
          <strong>{t("loginSceneSaved")}</strong>
          <small>Codex</small>
        </div>

        <SceneCat className="oauth-cat" />
      </div>

      <div className="oauth-scene-steps" aria-hidden="true">
        <span>{t("loginSceneStepCode")}</span>
        <span>{t("loginSceneStepAuthorize")}</span>
        <span>{t("loginSceneStepSaved")}</span>
      </div>
    </div>
  );
}

export function LoginFlow({ t }: { t: Translate }) {
  const steps: { detail: string; icon: FlowIconKind; label: string }[] = [
    {
      detail: t("loginFlowPairingDetail"),
      icon: "pairing",
      label: t("loginFlowPairing"),
    },
    {
      detail: t("loginFlowBrowserDetail"),
      icon: "browser",
      label: t("loginFlowBrowser"),
    },
    {
      detail: t("loginFlowAuthFileDetail"),
      icon: "file",
      label: "auth.json",
    },
    {
      detail: t("loginFlowCodexDetail"),
      icon: "codex",
      label: t("loginFlowCodex"),
    },
  ];
  const connectors = [
    t("loginFlowContinue"),
    t("loginFlowAuthorized"),
    t("flowNextRequest"),
  ];

  return (
    <section className="login-flow-guide" aria-labelledby="login-flow-title">
      <div className="login-flow-heading">
        <span className="eyebrow">{t("loginFlowEyebrow")}</span>
        <h2 id="login-flow-title">{t("loginFlowTitle")}</h2>
        <p>{t("loginFlowDescription")}</p>
      </div>

      <OAuthCatScene t={t} />

      <div className="login-flow" role="list">
        {steps.map((step, index) => (
          <div className="login-flow-fragment" key={step.label}>
            <div className="flow-step" role="listitem">
              <div className={`flow-icon ${step.icon}`}>
                <FlowIcon kind={step.icon} />
              </div>
              <strong>{step.label}</strong>
              <span>{step.detail}</span>
            </div>
            {index < connectors.length && (
              <FlowConnector label={connectors[index]} />
            )}
          </div>
        ))}
      </div>

      <div className="login-flow-notes">
        <strong>{t("loginFlowSharedAuth")}</strong>
        <span>{t("loginFlowPrivacyNote")}</span>
      </div>
    </section>
  );
}
