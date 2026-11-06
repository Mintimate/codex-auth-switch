import { useEffect, useRef, useState } from "react";
import type { Translate } from "./i18n";

export function SwitchAccountDialog({
  label,
  restartSupported,
  carryProjects,
  onClose,
  onConfirm,
  t,
}: {
  label: string;
  restartSupported: boolean;
  carryProjects: boolean;
  onClose: () => void;
  onConfirm: (
    restart: boolean,
    remember: boolean,
    carryProjects: boolean,
  ) => void;
  t: Translate;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const switchOnlyRef = useRef<HTMLButtonElement>(null);
  const [remember, setRemember] = useState(false);
  const [inheritProjects, setInheritProjects] = useState(carryProjects);
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
          checked={inheritProjects}
          onChange={(event) => setInheritProjects(event.target.checked)}
          aria-describedby="switch-projects-hint"
        />
        <span>{t("carryLocalProjects")}</span>
      </label>
      <p id="switch-projects-hint" className="switch-result-hint">
        {t("carryLocalProjectsHint")}
      </p>
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
          onClick={() => onConfirm(false, remember, inheritProjects)}
        >
          {t("switchOnly")}
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!restartSupported}
          onClick={() => onConfirm(true, remember, inheritProjects)}
        >
          {t("switchAndRestart")}
        </button>
      </div>
    </dialog>
  );
}
