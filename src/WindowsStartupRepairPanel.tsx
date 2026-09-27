import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Search, Wrench } from "lucide-react";
import {
  inspectWindowsStartup,
  repairWindowsStartup,
  windowsStartupRepairSupported,
  type WindowsStartupInspection,
} from "./api";
import type { MessageKey, Translate } from "./i18n";
import { isPublicDemo } from "./runtime";

const inspectionKeys: Record<
  Exclude<WindowsStartupInspection["status"], "ready">,
  MessageKey
> = {
  unsupported: "windowsStartupUnsupported",
  notFound: "windowsStartupNotFound",
  ambiguous: "windowsStartupAmbiguous",
  running: "windowsStartupRunning",
  unavailable: "windowsStartupInspectFailed",
};

const errorKeys = new Map<string, MessageKey>([
  ["unsupported", "windowsStartupUnsupported"],
  ["notFound", "windowsStartupNotFound"],
  ["ambiguous", "windowsStartupAmbiguous"],
  ["running", "windowsStartupRunning"],
  ["inspectFailed", "windowsStartupInspectFailed"],
  ["staleCheck", "windowsStartupStaleCheck"],
  ["busy", "windowsStartupBusy"],
  ["repairFailed", "windowsStartupRepairFailed"],
  ["repairUncertain", "windowsStartupRepairUncertain"],
]);

function errorKey(error: unknown, fallback: MessageKey): MessageKey {
  const code =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? error.message
        : null;
  return typeof code === "string"
    ? (errorKeys.get(code) ?? fallback)
    : fallback;
}

export function WindowsStartupRepairPanel({ t }: { t: Translate }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [inspection, setInspection] = useState<WindowsStartupInspection | null>(
    null,
  );
  const [busy, setBusy] = useState<"inspecting" | "repairing" | null>(null);
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    let disposed = false;
    mounted.current = true;
    void windowsStartupRepairSupported()
      .then((value) => {
        if (!disposed) setSupported(value);
      })
      .catch(() => {
        if (!disposed) setError("windowsStartupInspectFailed");
      });
    return () => {
      disposed = true;
      mounted.current = false;
    };
  }, []);

  const inspect = async () => {
    if (pending.current || isPublicDemo || supported === false) return;
    pending.current = true;
    setBusy("inspecting");
    setInspection(null);
    setNotice(null);
    setError(null);
    try {
      const available = supported ?? (await windowsStartupRepairSupported());
      if (!mounted.current) return;
      setSupported(available);
      if (!available) return;
      const result = await inspectWindowsStartup();
      if (!mounted.current) return;
      if (result.status === "ready") {
        if (result.checkId && result.version) setInspection(result);
        else setError("windowsStartupInspectFailed");
      } else {
        if (result.status === "unsupported") setSupported(false);
        setNotice(
          inspectionKeys[result.status] ?? "windowsStartupInspectFailed",
        );
      }
    } catch (cause) {
      if (mounted.current)
        setError(errorKey(cause, "windowsStartupInspectFailed"));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const repair = async () => {
    if (pending.current || isPublicDemo || !supported || !inspection?.checkId)
      return;
    pending.current = true;
    const checkId = inspection.checkId;
    // A check is single-use; no result or error may leave an old repair action enabled.
    setInspection(null);
    setBusy("repairing");
    setNotice(null);
    setError(null);
    try {
      const result = await repairWindowsStartup(checkId);
      if (!mounted.current) return;
      setNotice(
        result.outcome === "opened"
          ? "windowsStartupOpened"
          : "windowsStartupLaunchFailed",
      );
    } catch (cause) {
      if (mounted.current)
        setError(errorKey(cause, "windowsStartupRepairFailed"));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  return (
    <section
      className="settings-group labs-feature windows-startup-repair"
      aria-labelledby="windows-startup-title"
      aria-busy={busy !== null}
    >
      <div className="settings-group-heading">
        <div className="labs-feature-title">
          <h3 id="windows-startup-title">{t("windowsStartupTitle")}</h3>
          <span className="experimental-badge">{t("experimental")}</span>
        </div>
        <p>{t("windowsStartupDescription")}</p>
      </div>
      <div className="labs-feature-details">
        {isPublicDemo || supported === false ? (
          <p role="status">
            {t(
              isPublicDemo ? "windowsStartupDemo" : "windowsStartupUnsupported",
            )}
          </p>
        ) : (
          <>
            <p>{t("windowsStartupInspectHint")}</p>
            {inspection && (
              <div className="windows-startup-repair-ready" role="status">
                <strong>
                  {t("windowsStartupVersion", {
                    version: inspection.version ?? "",
                  })}
                </strong>
                <p>{t("windowsStartupRepairScope")}</p>
                <p>{t("windowsStartupSaveWork")}</p>
                <p>{t("windowsStartupDataKept")}</p>
              </div>
            )}
            {notice && (
              <p className="windows-startup-repair-notice" role="status">
                {t(notice)}
              </p>
            )}
            {error && (
              <p className="windows-startup-repair-error" role="alert">
                {t(error)}
              </p>
            )}
            {busy && (
              <p className="windows-startup-repair-progress" role="status">
                <LoaderCircle
                  className="hosted-spinner"
                  size={16}
                  aria-hidden="true"
                />
                {t(
                  busy === "inspecting"
                    ? "windowsStartupInspecting"
                    : "windowsStartupRepairing",
                )}
              </p>
            )}
            <div className="windows-startup-repair-actions">
              <button
                type="button"
                className="button secondary"
                disabled={
                  busy !== null || (supported === null && error === null)
                }
                onClick={() => void inspect()}
              >
                <Search size={15} aria-hidden="true" />
                {t(
                  inspection || notice || error
                    ? "windowsStartupInspectAgain"
                    : "windowsStartupInspect",
                )}
              </button>
              {inspection && (
                <button
                  type="button"
                  className="button primary"
                  disabled={busy !== null || isPublicDemo}
                  onClick={() => void repair()}
                >
                  <Wrench size={15} aria-hidden="true" />
                  {t("windowsStartupRepair")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
