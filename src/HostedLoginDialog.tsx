import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, LoaderCircle } from "lucide-react";
import {
  cancelHostedLogin,
  copyHostedLogin,
  getHostedLogin,
  openHostedLogin,
} from "./api";
import type { HostedLoginError, HostedLoginStatus } from "./api";
import { DialogPresence } from "./AppDialogs";
import type { MessageKey, Translate } from "./i18n";

const errors: Record<HostedLoginError, MessageKey> = {
  unavailable: "hostedErrorUnavailable",
  unsupported: "hostedErrorUnsupported",
  portInUse: "hostedErrorPort",
  network: "hostedErrorNetwork",
  rateLimited: "hostedErrorRate",
  rejected: "hostedErrorRejected",
  invalidResponse: "hostedErrorResponse",
  storage: "hostedErrorStorage",
  expired: "hostedErrorExpired",
  cleanup: "hostedErrorCleanup",
  cancelled: "hostedErrorCancelled",
  busy: "hostedErrorBusy",
  browser: "hostedErrorBrowser",
  clipboard: "hostedErrorClipboard",
};
export const hostedErrorKey = (reason: unknown): MessageKey =>
  typeof reason === "string" && Object.hasOwn(errors, reason)
    ? errors[reason as HostedLoginError]
    : "hostedErrorResponse";
export const hostedActive = (login: HostedLoginStatus) =>
  ["preparing", "waiting", "saving"].includes(login.phase) ||
  (login.cleanupPending && login.error !== "cleanup");

type Props = {
  login: HostedLoginStatus | null;
  onChange: (login: HostedLoginStatus | null) => void;
  onSaved: () => Promise<void>;
  onSwitch: (id: string) => Promise<void>;
  onDevice: () => void;
  requiresFileStorage: boolean;
  t: Translate;
};

export function HostedLoginDialog(props: Props) {
  const { login, onChange, onDevice, requiresFileStorage, t } = props;
  const propsRef = useRef(props);
  propsRef.current = props;
  const [actionError, setActionError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savedReady, setSavedReady] = useState(false);
  const actionRef = useRef(false);
  const openedRef = useRef<string | null>(null);
  const savedRef = useRef<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const id = login?.sessionId;

  useEffect(() => {
    setActionError(null);
    setCopied(false);
    setSavedReady(false);
    if (!id) return;
    cancelButtonRef.current?.focus();
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await getHostedLogin();
        if (disposed || actionRef.current) return;
        if (!next || next.sessionId !== id) {
          setActionError("hostedErrorCancelled");
          return;
        }
        propsRef.current.onChange(next);
        if (!hostedActive(next)) return;
      } catch {
        if (!disposed) setActionError("hostedErrorStatus");
      } finally {
        if (
          !disposed &&
          propsRef.current.login &&
          hostedActive(propsRef.current.login)
        ) {
          timer = window.setTimeout(() => void poll(), 800);
        }
      }
    };
    void poll();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [id]);

  useEffect(() => {
    if (!id || login?.phase !== "waiting" || openedRef.current === id) return;
    openedRef.current = id;
    void openHostedLogin(id).catch((reason) => {
      if (
        propsRef.current.login?.sessionId === id &&
        propsRef.current.login.phase === "waiting"
      )
        setActionError(hostedErrorKey(reason));
    });
  }, [id, login?.phase]);

  useEffect(() => {
    if (!id || login?.phase !== "completed" || savedRef.current === id) return;
    savedRef.current = id;
    setActionError(null);
    void propsRef.current
      .onSaved()
      .then(() => {
        if (propsRef.current.login?.sessionId === id) setSavedReady(true);
      })
      .catch(() => {
        if (propsRef.current.login?.sessionId === id)
          setActionError("hostedErrorStatus");
      });
  }, [id, login?.phase]);

  const action = async (run: () => Promise<void>) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setBusy(true);
    setActionError(null);
    try {
      await run();
    } catch (reason) {
      setActionError(hostedErrorKey(reason));
    } finally {
      actionRef.current = false;
      setBusy(false);
    }
  };
  const close = () =>
    void action(async () => {
      if (!login) return;
      if (hostedActive(login)) {
        const result = await cancelHostedLogin(login.sessionId);
        onChange(result);
        // 提交可能先于取消；保留成功结果，避免把已保存报告为取消。
        if (result.phase === "completed" || result.cleanupPending) return;
      }
      onChange(null);
    });
  const completed = login?.phase === "completed";
  const waiting = login?.phase === "waiting";
  const active = login ? hostedActive(login) : false;
  return (
    <DialogPresence
      open={Boolean(login)}
      onBackdropMouseDown={() => {
        if (!active && !busy) close();
      }}
    >
      {login && (
        <section
          className="dialog hosted-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="hosted-login-title"
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.preventDefault();
              close();
            }
            if (event.key === "Tab") {
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ),
              );
              const first = buttons[0];
              const last = buttons[buttons.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <span className="eyebrow">{t("hostedLoginTitle")}</span>
          <div className="hosted-status-icon" aria-hidden="true">
            {completed ? (
              <CheckCircle2 size={32} />
            ) : active ? (
              <LoaderCircle className="hosted-spinner" size={32} />
            ) : (
              <ExternalLink size={32} />
            )}
          </div>
          <h2 id="hosted-login-title">
            {t(
              completed
                ? "hostedSaved"
                : waiting
                  ? "hostedWaiting"
                  : login.phase === "preparing"
                    ? "hostedPreparing"
                    : login.phase === "saving"
                      ? "hostedSaving"
                      : "hostedStopped",
            )}
          </h2>
          <p role="status">
            {t(
              completed
                ? "hostedSavedHint"
                : waiting
                  ? "hostedWaitingHint"
                  : "hostedSaveOnly",
            )}
          </p>
          {(login.error || actionError) && (
            <p className="hosted-error" role="alert">
              {t(actionError ?? hostedErrorKey(login.error))}
            </p>
          )}
          {copied && <p role="status">{t("hostedCopied")}</p>}
          {waiting && (
            <div className="hosted-browser-actions">
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void action(() => openHostedLogin(login.sessionId))
                }
              >
                <ExternalLink size={16} />
                {t("hostedOpenBrowser")}
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await copyHostedLogin(login.sessionId);
                    setCopied(true);
                  })
                }
              >
                {t("hostedCopyLink")}
              </button>
            </div>
          )}
          {completed && requiresFileStorage && (
            <p className="login-config-notice">{t("hostedStorageHint")}</p>
          )}
          <div className="dialog-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={close}
              ref={cancelButtonRef}
              autoFocus
            >
              {t(active && !completed ? "cancel" : "close")}
            </button>
            {!active && !completed && (
              <button
                className="button primary"
                disabled={busy}
                onClick={onDevice}
              >
                {t("hostedTryDevice")}
              </button>
            )}
            {completed && login.profileId && (
              <button
                className="button primary"
                disabled={busy || !savedReady || login.cleanupPending}
                onClick={() =>
                  void action(() => propsRef.current.onSwitch(login.profileId!))
                }
              >
                {t(
                  requiresFileStorage
                    ? "hostedEnableAndSwitch"
                    : "hostedSwitch",
                )}
              </button>
            )}
          </div>
        </section>
      )}
    </DialogPresence>
  );
}
