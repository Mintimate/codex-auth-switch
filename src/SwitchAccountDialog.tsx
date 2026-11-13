import { useEffect, useRef, useState } from "react";
import type { Translate } from "./i18n";

export function SwitchAccountDialog({
  label,
  restartSupported,
  onClose,
  onConfirm,
  t,
}: {
  label: string;
  restartSupported: boolean;
  onClose: () => void;
  onConfirm: (restart: boolean, remember: boolean) => void;
  t: Translate;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const switchOnlyRef = useRef<HTMLButtonElement>(null);
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    switchOnlyRef.current?.focus();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="dialog switch-account-dialog"
      aria-labelledby="switch-dialog-title"
      aria-describedby="switch-dialog-description"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id="switch-dialog-title">{t("switchAccountTitle", { label })}</h2>
      <p id="switch-dialog-description">{t("switchAccountDescription")}</p>
      {!restartSupported && <p>{t("desktopRestartUnavailable")}</p>}
      <label className="switch-remember-choice">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />
        <span>{t("rememberSwitchChoice")}</span>
      </label>
      <div className="dialog-actions">
        <button type="button" className="button ghost" onClick={onClose}>
          {t("cancel")}
        </button>
        <button
          type="button"
          className="button secondary"
          ref={switchOnlyRef}
          autoFocus
          onClick={() => onConfirm(false, remember)}
        >
          {t("switchOnly")}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!restartSupported}
          onClick={() => onConfirm(true, remember)}
        >
          {t("switchAndRestart")}
        </button>
      </div>
    </dialog>
  );
}
