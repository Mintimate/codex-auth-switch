import type { Translate } from "./i18n";

type RestartRequiredAlertProps = {
  onDismiss: () => void;
  t: Translate;
};

export function RestartRequiredAlert({
  onDismiss,
  t,
}: RestartRequiredAlertProps) {
  return (
    <section
      className="alert warning restart-required-alert"
      role="status"
      aria-live="polite"
    >
      <span className="restart-required-icon" aria-hidden="true">
        ↻
      </span>
      <span>
        <strong>{t("switchRestartTitle")}</strong>
        <br />
        {t("switchRestartNotice")}
      </span>
      <button
        type="button"
        className="alert-close"
        aria-label={t("acknowledge")}
        title={t("acknowledge")}
        onClick={onDismiss}
      >
        <span>{t("acknowledge")}</span>
      </button>
    </section>
  );
}
