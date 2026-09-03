import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { LoginFlow } from "./AccountFlow";
import type { DeviceLoginResponse } from "./api";
import { localizeBackendError } from "./i18n";
import type { Locale, Translate } from "./i18n";
import { containsEmail } from "./privacy";

export type DialogMode = "save" | "login" | "rename" | null;

export type PendingDeviceLogin = {
  label: string;
  response: DeviceLoginResponse;
  expiresAt: number;
};

export type ShareDialogState = {
  profileId: string;
  label: string;
  qrDataUrl: string | null;
  qrError: string | null;
  preparing: boolean;
  prepared: boolean;
  copied: boolean;
  copyError: string | null;
};

export type RemoveDialogState = {
  profileId: string;
  label: string;
  active: boolean;
};

const DIALOG_EXIT_ANIMATION_MS = 180;
const OAUTH_PIXEL_COUNT = 14;
// 前端限制文件大小，后端仍会按解码后的字节数独立校验。
const QR_MAX_FILE_BYTES = 12 * 1024 * 1024;

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// 分块转换，避免对大型图片展开整个 Uint8Array 导致调用栈溢出。
const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
};

function DialogPresence({
  children,
  onBackdropMouseDown,
  open,
}: {
  children: ReactNode;
  onBackdropMouseDown?: () => void;
  open: boolean;
}) {
  const [rendered, setRendered] = useState(open);
  const [visible, setVisible] = useState(false);
  const contentRef = useRef(children);

  if (open) contentRef.current = children;

  useEffect(() => {
    let frame: number | undefined;
    let revealFrame: number | undefined;
    let timer: number | undefined;

    if (open) {
      setRendered(true);
      frame = window.requestAnimationFrame(() => {
        revealFrame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      timer = window.setTimeout(
        () => setRendered(false),
        reducedMotion ? 0 : DIALOG_EXIT_ANIMATION_MS,
      );
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (revealFrame !== undefined) window.cancelAnimationFrame(revealFrame);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open]);

  if (!rendered) return null;

  return (
    <div
      className={`dialog-backdrop ${visible ? "is-visible" : "is-closing"}`}
      role="presentation"
      aria-hidden={!open}
      onMouseDown={onBackdropMouseDown}
    >
      {contentRef.current}
    </div>
  );
}

export function RemoveAccountDialog({
  dialog,
  onClose,
  onConfirm,
  t,
}: {
  dialog: RemoveDialogState | null;
  onClose: () => void;
  onConfirm: () => void;
  t: Translate;
}) {
  return (
    <DialogPresence open={Boolean(dialog)} onBackdropMouseDown={onClose}>
      {dialog ? (
        <section
          className="dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="remove-dialog-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <span className="eyebrow">{t("localVault")}</span>
          <h2 id="remove-dialog-title">
            {t("removeAccountTitle", { label: dialog.label })}
          </h2>
          <p>
            {t("removeAccountDescription", {
              activeSuffix: dialog.active
                ? t("activeRemoveSuffix")
                : t("inactiveRemoveSuffix"),
            })}
          </p>
          {dialog.active && (
            <p className="remove-dialog-note">{t("activeRemoveNote")}</p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              className="button danger-button"
              onClick={onConfirm}
            >
              {t("removeLocalOnly")}
            </button>
          </div>
        </section>
      ) : null}
    </DialogPresence>
  );
}

export function ShareAuthDialog({
  dialog,
  onClose,
  onCopy,
  onPrepare,
  t,
}: {
  dialog: ShareDialogState | null;
  onClose: () => void;
  onCopy: () => void;
  onPrepare: () => void;
  t: Translate;
}) {
  return (
    <DialogPresence open={Boolean(dialog)} onBackdropMouseDown={onClose}>
      {dialog ? (
        <section
          className="dialog share-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="share-dialog-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <span className="eyebrow">{t("authSharing")}</span>
          <h2 id="share-dialog-title">
            {t("shareAccountTitle", { label: dialog.label })}
          </h2>
          <p>{t("shareDescription")}</p>
          <div className="share-qr" aria-live="polite">
            {dialog.qrDataUrl ? (
              <img
                src={dialog.qrDataUrl}
                alt={t("shareQrAlt", { label: dialog.label })}
              />
            ) : dialog.qrError ? (
              <div className="share-qr-message">
                <strong>
                  {dialog.prepared
                    ? t("qrGenerationFailed")
                    : t("transferPreparationFailed")}
                </strong>
                <span>{dialog.qrError}</span>
              </div>
            ) : dialog.preparing ? (
              <div className="share-qr-message">
                <span className="inline-spinner" />
                <span>{t("qrGenerating")}</span>
              </div>
            ) : (
              <div className="share-qr-message">
                <strong>{t("beforeTransferTitle")}</strong>
                <span>{t("beforeTransferHint")}</span>
              </div>
            )}
          </div>
          <p className="sensitive-warning">{t("shareWarning")}</p>
          {dialog.copied && (
            <p className="share-feedback success-text">{t("copiedHint")}</p>
          )}
          {dialog.copyError && (
            <p className="share-feedback error-text">{dialog.copyError}</p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
            >
              {t("done")}
            </button>
            {dialog.prepared ? (
              <button type="button" className="button primary" onClick={onCopy}>
                {dialog.copied ? t("copyAgain") : t("copyToClipboard")}
              </button>
            ) : (
              <button
                type="button"
                className="button primary"
                onClick={onPrepare}
                disabled={dialog.preparing}
              >
                {dialog.preparing
                  ? t("preparingTransfer")
                  : t("prepareTransfer")}
              </button>
            )}
          </div>
        </section>
      ) : null}
    </DialogPresence>
  );
}

export function ImportAuthDialog({
  busy,
  error,
  locale,
  onClose,
  onError,
  onImportClipboard,
  onImportQr,
  open,
  t,
}: {
  busy: boolean;
  error: string | null;
  locale: Locale;
  onClose: () => void;
  onError: (message: string) => void;
  onImportClipboard: () => Promise<void>;
  onImportQr: (image: string) => Promise<void>;
  open: boolean;
  t: Translate;
}) {
  const qrFileInput = useRef<HTMLInputElement>(null);

  const importQrFile = async (file: File) => {
    if (file.size > QR_MAX_FILE_BYTES) {
      onError(t("qrTooLarge"));
      return;
    }
    try {
      const image = toBase64(new Uint8Array(await file.arrayBuffer()));
      await onImportQr(image);
    } catch (reason) {
      onError(
        t("qrReadFailed", {
          message: localizeBackendError(messageOf(reason), locale),
        }),
      );
    }
  };

  return (
    <DialogPresence open={open} onBackdropMouseDown={onClose}>
      {open ? (
        <section
          className="dialog import-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="import-dialog-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <span className="eyebrow">{t("authImport")}</span>
          <h2 id="import-dialog-title">{t("chooseImportMethod")}</h2>
          <p>{t("importDescription")}</p>
          <div className="import-options">
            <button
              type="button"
              className="import-option"
              disabled={busy}
              onClick={() => void onImportClipboard()}
            >
              <span className="import-option-icon" aria-hidden="true">
                ⎘
              </span>
              <span>
                <strong>{t("importClipboard")}</strong>
                <small>{t("importClipboardHint")}</small>
              </span>
            </button>
            <button
              type="button"
              className="import-option"
              disabled={busy}
              onClick={() => qrFileInput.current?.click()}
            >
              <span className="import-option-icon qr-icon" aria-hidden="true">
                ▦
              </span>
              <span>
                <strong>{t("importQr")}</strong>
                <small>{t("importQrHint")}</small>
              </span>
            </button>
            <input
              ref={qrFileInput}
              className="visually-hidden"
              type="file"
              aria-hidden="true"
              tabIndex={-1}
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void importQrFile(file);
              }}
            />
          </div>
          <p className="sensitive-warning">{t("importWarning")}</p>
          {error && <p className="share-feedback error-text">{error}</p>}
          <div className="dialog-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={onClose}
            >
              {t("cancel")}
            </button>
          </div>
        </section>
      ) : null}
    </DialogPresence>
  );
}

export function DeviceLoginDialog({
  login,
  onClose,
  t,
}: {
  login: PendingDeviceLogin | null;
  onClose: () => void;
  t: Translate;
}) {
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => setFeedback(null), [login?.response.deviceCode]);

  const copyText = async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback({ kind: "success", message: successMessage });
    } catch {
      setFeedback({ kind: "error", message: t("pairingCopyFailed") });
    }
  };

  const openLoginPage = () => {
    if (!login) return;
    void openUrl(login.response.verificationUri).catch(() =>
      setFeedback({ kind: "error", message: t("browserOpenFailed") }),
    );
  };

  return (
    <DialogPresence open={Boolean(login)}>
      {login ? (
        <section
          className="dialog device-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="device-login-title"
        >
          <span className="eyebrow">{t("deviceCodeLogin")}</span>
          <h2 id="device-login-title">{t("completeLoginInBrowser")}</h2>
          <p>{t("deviceLoginDescription")}</p>
          <span className="pairing-label">{t("browserUrl")}</span>
          <button
            className="device-url"
            type="button"
            title={t("openLoginPage")}
            onClick={openLoginPage}
          >
            {login.response.verificationUri}
          </button>
          <span className="pairing-label">{t("pairingCode")}</span>
          <button
            className="device-code"
            type="button"
            title={t("copyVerificationCode")}
            onClick={() =>
              void copyText(
                login.response.userCode,
                t("verificationCodeCopied"),
              )
            }
          >
            {login.response.userCode}
          </button>
          {feedback && (
            <p className={`pairing-feedback ${feedback.kind}`} role="status">
              {feedback.message}
            </p>
          )}
          <span className="device-code-hint">{t("deviceCodeClickToCopy")}</span>
          <div className="polling-state" role="status">
            <span className="polling-dot" />
            {t("waitingBrowser")}
          </div>
          <p className="device-hint">{t("deviceLoginHint")}</p>
          <div className="dialog-actions device-actions">
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                void copyText(
                  t("pairingDetailsText", {
                    url: login.response.verificationUri,
                    code: login.response.userCode,
                  }),
                  t("pairingDetailsCopied"),
                )
              }
            >
              {t("copyPairingDetails")}
            </button>
            <button
              type="button"
              className="button primary"
              onClick={openLoginPage}
            >
              {t("openLoginPage")}
            </button>
          </div>
        </section>
      ) : null}
    </DialogPresence>
  );
}

export function AccountNameDialog({
  label,
  mode,
  oauthTransitioning,
  onClose,
  onLabelChange,
  onSubmit,
  privateMode,
  requiresFileStorage,
  storageMode,
  t,
}: {
  label: string;
  mode: DialogMode;
  oauthTransitioning: boolean;
  onClose: () => void;
  onLabelChange: (label: string) => void;
  onSubmit: () => void;
  privateMode: boolean;
  requiresFileStorage: boolean;
  storageMode: string;
  t: Translate;
}) {
  return (
    <DialogPresence
      open={Boolean(mode)}
      onBackdropMouseDown={() => {
        if (!oauthTransitioning) onClose();
      }}
    >
      {mode ? (
        <form
          className={`dialog${
            mode === "login"
              ? ` login-dialog${
                  oauthTransitioning ? " oauth-is-launching" : ""
                }`
              : ""
          }`}
          role="dialog"
          aria-modal="true"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {mode === "login" && <LoginFlow t={t} />}
          <div className={mode === "login" ? "login-form-pane" : undefined}>
            <span className="eyebrow">
              {mode === "login"
                ? t("browserLogin")
                : mode === "save"
                  ? t("saveCurrentLogin")
                  : t("accountName")}
            </span>
            <h2>
              {mode === "login"
                ? t("nameNewAccount")
                : mode === "save"
                  ? t("saveThisAccount")
                  : t("renameAccount")}
            </h2>
            <label htmlFor="account-label">{t("displayName")}</label>
            <input
              id="account-label"
              autoFocus
              autoComplete="off"
              maxLength={60}
              type={privateMode && containsEmail(label) ? "password" : "text"}
              value={label}
              onChange={(event) => onLabelChange(event.target.value)}
              placeholder={t("accountNamePlaceholder")}
            />
            {mode === "login" && requiresFileStorage && (
              <div className="login-config-notice" role="note">
                <strong>{t("loginRequiresFileStorage")}</strong>
                <span>
                  {t("loginRequiresFileStorageHint", { mode: storageMode })}
                </span>
                <code>cli_auth_credentials_store = &quot;file&quot;</code>
              </div>
            )}
            {mode === "login" && <p>{t("deviceLoginNextStep")}</p>}
            <div className="dialog-actions">
              <button
                type="button"
                className="button secondary"
                disabled={oauthTransitioning}
                onClick={onClose}
              >
                {t("cancel")}
              </button>
              <button
                type="submit"
                className={`button primary${
                  mode === "login" ? " oauth-launch-button" : ""
                }`}
                disabled={!label.trim() || oauthTransitioning}
              >
                {mode === "login"
                  ? requiresFileStorage
                    ? t("modifyConfigAndRequestLoginCode")
                    : t("requestLoginCodeButton")
                  : t("continue")}
                {mode === "login" && (
                  <span className="oauth-pixel-burst" aria-hidden="true">
                    {Array.from({ length: OAUTH_PIXEL_COUNT }, (_, index) => (
                      <i key={index} />
                    ))}
                  </span>
                )}
              </button>
            </div>
          </div>
        </form>
      ) : null}
    </DialogPresence>
  );
}
