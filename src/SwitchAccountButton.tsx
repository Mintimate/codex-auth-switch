import type { Translate } from "./i18n";
import "./SwitchAccountButton.css";

type SwitchAccountButtonProps = {
  disabled: boolean;
  switching: boolean;
  onClick: () => void;
  restart: boolean;
  t: Translate;
};

export function SwitchAccountButton({
  disabled,
  switching,
  onClick,
  restart,
  t,
}: SwitchAccountButtonProps) {
  return (
    <button
      type="button"
      className="account-action primary-action switch-account-button"
      disabled={disabled || switching}
      aria-busy={switching}
      aria-label={
        switching
          ? t("switchingAccount")
          : t(restart ? "switchAndRestart" : "switchToAccount")
      }
      title={t(restart ? "switchAndRestart" : "switchToAccount")}
      onClick={onClick}
    >
      <svg
        className="switch-account-arrows"
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M4 7h15m-4-4 4 4-4 4" />
        <path d="M20 17H5m4-4-4 4 4 4" />
      </svg>
      <span className="switch-account-label" aria-hidden="true">
        {t("switchAccountShort")}
      </span>
    </button>
  );
}
