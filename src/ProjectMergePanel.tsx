import { useEffect, useRef, useState } from "react";
import { GitMerge, LoaderCircle } from "lucide-react";
import {
  mergeLocalProjects,
  type AppStatus,
  type ProjectMergeResult,
} from "./api";
import {
  localizeBackendError,
  type Locale,
  type MessageKey,
  type Translate,
} from "./i18n";
import { redactEmails } from "./privacy";
import { isPublicDemo } from "./runtime";

const outcomeKeys: Record<ProjectMergeResult["outcome"], MessageKey> = {
  copied: "projectMergeCopied",
  reordered: "projectMergeReordered",
  notNeeded: "projectMergeNotNeeded",
  failed: "projectMergeFailed",
};

export function ProjectMergePanel({
  status,
  privateMode,
  locale,
  desktopSupported,
  accountBusy,
  t,
}: {
  status: AppStatus | null;
  privateMode: boolean;
  locale: Locale;
  desktopSupported: boolean;
  accountBusy: boolean;
  t: Translate;
}) {
  const accounts = status?.accounts ?? [];
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState(
    () => status?.accounts.find((account) => account.active)?.id ?? "",
  );
  const [merging, setMerging] = useState(false);
  const [result, setResult] = useState<ProjectMergeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const validSelection =
    sourceId !== targetId &&
    [sourceId, targetId].every((id) =>
      accounts.some((account) => account.id === id),
    );
  const unavailable = isPublicDemo || !desktopSupported || accounts.length < 2;
  const disabled = merging || accountBusy || unavailable;

  const merge = async () => {
    if (pending.current || disabled || !validSelection) return;
    pending.current = true;
    setMerging(true);
    setResult(null);
    setError(null);
    try {
      const next = await mergeLocalProjects(sourceId, targetId);
      if (mounted.current) setResult(next);
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setMerging(false);
    }
  };

  return (
    <section
      className="settings-group labs-feature project-merge"
      aria-labelledby="project-merge-title"
      aria-busy={merging}
    >
      <div className="settings-group-heading">
        <div className="labs-feature-title">
          <h3 id="project-merge-title">{t("projectMergeTitle")}</h3>
          <span className="experimental-badge">{t("experimental")}</span>
        </div>
        <p>{t("projectMergeDescription")}</p>
      </div>
      <div className="labs-feature-details">
        <p>{t("projectMergeScope")}</p>
        <p>{t("projectMergeQuitHint")}</p>
        {unavailable ? (
          <p role="status">
            {t(
              isPublicDemo
                ? "projectMergeDemo"
                : !desktopSupported
                  ? "projectMergeUnsupported"
                  : "projectMergeNeedAccounts",
            )}
          </p>
        ) : (
          <>
            <div className="project-merge-accounts">
              {(["source", "target"] as const).map((role) => (
                <label key={role} htmlFor={`project-merge-${role}`}>
                  <span>
                    {t(
                      role === "source"
                        ? "projectMergeSource"
                        : "projectMergeTarget",
                    )}
                  </span>
                  <select
                    id={`project-merge-${role}`}
                    value={role === "source" ? sourceId : targetId}
                    disabled={disabled}
                    onChange={(event) => {
                      (role === "source" ? setSourceId : setTargetId)(
                        event.target.value,
                      );
                      setResult(null);
                      setError(null);
                    }}
                  >
                    <option value="">{t("projectMergeChooseAccount")}</option>
                    {accounts.map((account) => (
                      <option
                        key={account.id}
                        value={account.id}
                        disabled={
                          account.id ===
                          (role === "source" ? targetId : sourceId)
                        }
                      >
                        {privateMode
                          ? redactEmails(account.label, t("emailHidden"))
                          : account.label}
                        {account.active
                          ? ` · ${t("projectMergeCurrentAccount")}`
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {result && (
              <div
                className={
                  result.outcome === "failed"
                    ? "project-merge-error"
                    : "project-merge-result"
                }
                role={result.outcome === "failed" ? "alert" : "status"}
              >
                <p>
                  {t(outcomeKeys[result.outcome], { count: result.copied })}
                </p>
                {result.skipped > 0 && (
                  <p>{t("projectMergeSkipped", { count: result.skipped })}</p>
                )}
              </div>
            )}
            {error && (
              <p className="project-merge-error" role="alert">
                {localizeBackendError(error, locale)}
              </p>
            )}
            <div className="labs-feature-actions">
              <button
                type="button"
                className="button secondary"
                disabled={disabled || !validSelection}
                onClick={() => void merge()}
              >
                {merging ? (
                  <LoaderCircle
                    size={16}
                    className="hosted-spinner"
                    aria-hidden="true"
                  />
                ) : (
                  <GitMerge size={16} aria-hidden="true" />
                )}
                {t(merging ? "projectMergeProgress" : "projectMergeAction")}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
