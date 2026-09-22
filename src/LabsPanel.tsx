import { FlaskConical } from "lucide-react";
import type { Translate } from "./i18n";

export function LabsPanel({
  hostedLoginEnabled,
  onHostedLoginChange,
  onTryHostedLogin,
  t,
}: {
  hostedLoginEnabled: boolean;
  onHostedLoginChange: (enabled: boolean) => void;
  onTryHostedLogin: () => void;
  t: Translate;
}) {
  return (
    <div className="settings-page labs-page">
      <header className="page-heading">
        <span className="eyebrow">{t("labsEyebrow")}</span>
        <h2>{t("labsTab")}</h2>
        <p>{t("labsDescription")}</p>
      </header>

      <section
        className="settings-group labs-feature"
        aria-labelledby="labs-hosted-title"
      >
        <div className="settings-group-heading labs-feature-heading">
          <FlaskConical size={24} aria-hidden="true" />
          <div>
            <div className="labs-feature-title">
              <h3 id="labs-hosted-title">{t("hostedLoginTitle")}</h3>
              <span className="experimental-badge">{t("experimental")}</span>
            </div>
            <p>{t("labsHostedDescription")}</p>
          </div>
        </div>
        <div className="settings-row">
          <div>
            <strong id="labs-hosted-toggle-label">
              {t("labsHostedToggle")}
            </strong>
            <span id="labs-hosted-toggle-hint">
              {t("labsHostedToggleHint")}
            </span>
          </div>
          <button
            type="button"
            className={`toggle${hostedLoginEnabled ? " active" : ""}`}
            role="switch"
            aria-checked={hostedLoginEnabled}
            aria-labelledby="labs-hosted-toggle-label"
            aria-describedby="labs-hosted-toggle-hint"
            onClick={() => onHostedLoginChange(!hostedLoginEnabled)}
          >
            <span />
          </button>
        </div>
        <div className="labs-feature-details">
          <p>{t("labsHostedCompatibility")}</p>
          <p>{t("labsHostedDisableHint")}</p>
          <div className="labs-feature-actions">
            <span role="status">
              {t(hostedLoginEnabled ? "labsEnabled" : "labsDisabled")}
            </span>
            {hostedLoginEnabled && (
              <button
                type="button"
                className="button secondary"
                onClick={onTryHostedLogin}
              >
                {t("labsTryLogin")}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
