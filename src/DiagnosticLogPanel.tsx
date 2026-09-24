import { useEffect, useRef, useState } from "react";
import { FileDown, RefreshCw, Trash2 } from "lucide-react";
import {
  clearDiagnosticLogs,
  exportDiagnosticLogs,
  getDiagnosticLogs,
  setDiagnosticLogging,
  type DiagnosticLogs,
} from "./api";
import type { MessageKey, Translate } from "./i18n";
import { isPublicDemo } from "./runtime";

const operationKeys: Record<string, MessageKey> = {
  deviceCode: "logDeviceCode",
  devicePoll: "logDevicePoll",
  oAuthExchange: "logOAuthExchange",
  oAuthRefresh: "logOAuthRefresh",
  quotaUsage: "logQuotaUsage",
  quotaCredits: "logQuotaCredits",
  appServerQuery: "logAppServerQuery",
  rpcInitialize: "logRpcInitialize",
  rpcAccount: "logRpcAccount",
  rpcLimits: "logRpcLimits",
  rpcUsage: "logRpcUsage",
  hostedInitialize: "logHostedInitialize",
  hostedLogin: "logHostedLogin",
  hostedAccount: "logHostedAccount",
  hostedResult: "logHostedResult",
};
const outcomeKeys: Record<string, MessageKey> = {
  success: "logSuccess",
  httpError: "logHttpError",
  timeout: "logTimeout",
  connect: "logConnect",
  network: "logNetwork",
  invalidResponse: "logInvalidResponse",
  rpcError: "logRpcError",
  rateLimited: "logRateLimited",
  unavailable: "logUnavailable",
  interrupted: "logInterrupted",
  unsupported: "logUnsupported",
  portInUse: "logPortInUse",
  rejected: "logRejected",
  storage: "logStorage",
  expired: "logExpired",
  cancelled: "logCancelled",
  cleanup: "logCleanup",
};

export function DiagnosticLogPanel({ t }: { t: Translate }) {
  const [logs, setLogs] = useState<DiagnosticLogs | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [failuresOnly, setFailuresOnly] = useState(false);
  const pending = useRef(false);

  useEffect(() => {
    let disposed = false;
    void getDiagnosticLogs()
      .then((value) => {
        if (!disposed) setLogs(value);
      })
      .catch(() => {
        if (!disposed) setError("logsLoadFailed");
      });
    return () => {
      disposed = true;
    };
  }, []);

  const action = async (run: () => Promise<void>, failure: MessageKey) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch {
      setError(failure);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const entries = [...(logs?.entries ?? [])]
    .reverse()
    .filter((entry) => !failuresOnly || entry.outcome !== "success");

  return (
    <section
      className="settings-group labs-feature diagnostic-logs"
      aria-labelledby="labs-logs-title"
    >
      <div className="settings-group-heading">
        <div className="labs-feature-title">
          <h3 id="labs-logs-title">{t("logsTitle")}</h3>
          <span className="experimental-badge">{t("experimental")}</span>
        </div>
        <p>{t("logsDescription")}</p>
      </div>
      <div className="settings-row">
        <div>
          <strong id="logs-toggle-label">{t("logsToggle")}</strong>
          <span id="logs-toggle-hint">{t("logsToggleHint")}</span>
        </div>
        <button
          type="button"
          className={`toggle${logs?.enabled ? " active" : ""}`}
          role="switch"
          aria-checked={logs?.enabled ?? false}
          aria-labelledby="logs-toggle-label"
          aria-describedby="logs-toggle-hint"
          disabled={isPublicDemo || busy || !logs || logs.warning === "read"}
          onClick={() =>
            void action(async () => {
              setLogs(await setDiagnosticLogging(!logs?.enabled));
            }, "logsToggleFailed")
          }
        >
          <span />
        </button>
      </div>
      <div className="labs-feature-details">
        <p>{t("logsPrivacy")}</p>
        <p>
          {t("logsRetention", {
            days: logs?.retentionDays ?? 7,
            count: logs?.maxEntries ?? 500,
          })}
        </p>
        <div className="diagnostic-log-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() =>
              void action(
                async () => setLogs(await getDiagnosticLogs()),
                "logsLoadFailed",
              )
            }
          >
            <RefreshCw size={15} aria-hidden="true" />
            {t("logsRefresh")}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={isPublicDemo || busy || !logs?.entries.length}
            onClick={() =>
              void action(
                async () => setExportPath(await exportDiagnosticLogs()),
                "logsExportFailed",
              )
            }
          >
            <FileDown size={15} aria-hidden="true" />
            {t("logsExport")}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={isPublicDemo || busy || !logs}
            onClick={() => setConfirmClear(true)}
          >
            <Trash2 size={15} aria-hidden="true" />
            {t("logsClear")}
          </button>
        </div>
        {confirmClear && (
          <div className="diagnostic-log-confirm">
            <p>{t("logsClearConfirm")}</p>
            <div className="diagnostic-log-actions">
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    setLogs(await clearDiagnosticLogs());
                    setExportPath(null);
                    setConfirmClear(false);
                  }, "logsClearFailed")
                }
              >
                {t("logsClear")}
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setConfirmClear(false)}
              >
                {t("cancel")}
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="quota-error" role="alert">
            {t(error)}
          </p>
        )}
        {logs?.warning && (
          <p className="quota-error" role="status">
            {t(
              logs.warning === "read" ? "logsReadWarning" : "logsWriteWarning",
            )}
          </p>
        )}
        {exportPath && (
          <p className="diagnostic-log-export" role="status">
            {t("logsExported")} <code>{exportPath}</code>
          </p>
        )}
        <div className="diagnostic-log-toolbar">
          <span role="status">
            {t(logs?.enabled ? "logsRecording" : "logsStopped")} ·{" "}
            {t("logsCount", { count: logs?.entries.length ?? 0 })}
          </span>
          <label>
            <input
              type="checkbox"
              checked={failuresOnly}
              onChange={(event) => setFailuresOnly(event.target.checked)}
            />
            {t("logsFailuresOnly")}
          </label>
        </div>
        {entries.length === 0 ? (
          <p className="diagnostic-log-empty">
            {t(failuresOnly ? "logsNoFailures" : "logsEmpty")}
          </p>
        ) : (
          <div className="diagnostic-log-list">
            {entries.map((entry) => (
              <details key={entry.id} className="diagnostic-log-entry">
                <summary>
                  <span className="diagnostic-log-time">
                    {new Date(entry.time * 1000).toLocaleString()}
                  </span>
                  <strong>
                    {operationKeys[entry.operation]
                      ? t(operationKeys[entry.operation])
                      : entry.operation}
                  </strong>
                  <span
                    className={
                      entry.outcome === "success"
                        ? ""
                        : "diagnostic-log-failure"
                    }
                  >
                    {entry.status ? `HTTP ${entry.status} · ` : ""}
                    {outcomeKeys[entry.outcome]
                      ? t(outcomeKeys[entry.outcome])
                      : entry.outcome}
                  </span>
                  <span>{entry.durationMs} ms</span>
                </summary>
                <p>
                  <code>
                    {entry.request.method} {entry.request.target}
                  </code>
                </p>
                <p>
                  {t("logsEntryMeta", {
                    group: entry.group,
                    attempt: entry.attempt,
                    proxy: entry.proxyMode
                      ? t(
                          entry.proxyMode === "system"
                            ? "proxyModeSystem"
                            : entry.proxyMode === "manual"
                              ? "proxyModeManual"
                              : "proxyModeOff",
                        )
                      : "—",
                    kind: entry.bodyKind,
                  })}
                </p>
                <pre tabIndex={0} aria-label={t("logsResponse")}>
                  {entry.response &&
                  typeof entry.response === "object" &&
                  Object.keys(entry.response).length > 0
                    ? JSON.stringify(entry.response, null, 2)
                    : t("logsResponseOmitted")}
                </pre>
              </details>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
