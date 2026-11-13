import { useEffect, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Select } from "./Select";
import {
  defaultMonitorSettings,
  monitorSettingLimits,
  normalizeMonitorSettings,
  type CallMonitorSnapshot,
  type MonitorSettings,
} from "./callMonitor";
import type { MessageKey, Translate } from "./i18n";

export const monitorRangeName = (hours: number, t: Translate) =>
  hours >= 48 && hours % 24 === 0
    ? t("monitorRecentDays", { count: hours / 24 })
    : t("monitorRecentHours", { count: hours });

const fields: {
  key: keyof MonitorSettings;
  label: MessageKey;
  hint: MessageKey;
}[] = [
  {
    key: "windowHours",
    label: "monitorRangeHours",
    hint: "monitorRangeHoursHint",
  },
  {
    key: "readDepthMiB",
    label: "monitorReadDepth",
    hint: "monitorReadDepthHint",
  },
  { key: "maxFiles", label: "monitorMaxFiles", hint: "monitorMaxFilesHint" },
  {
    key: "maxCallsPerFile",
    label: "monitorMaxFileCalls",
    hint: "monitorMaxFileCallsHint",
  },
  { key: "maxCalls", label: "monitorMaxCalls", hint: "monitorMaxCallsHint" },
  { key: "maxLineMiB", label: "monitorMaxLine", hint: "monitorMaxLineHint" },
];
const toDraft = (settings: MonitorSettings) =>
  Object.fromEntries(
    fields.map(({ key }) => [key, String(settings[key])]),
  ) as Record<keyof MonitorSettings, string>;

export function MonitorReadControls({
  settings,
  open,
  onOpenChange,
  onChange,
  t,
}: {
  settings: MonitorSettings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (settings: MonitorSettings) => void;
  t: Translate;
}) {
  const ranges = [1, 6, 24, 72, 168, 720];
  if (!ranges.includes(settings.windowHours)) ranges.push(settings.windowHours);
  return (
    <>
      <div className="monitor-read-controls">
        <label>
          <span>{t("monitorTimeRange")}</span>
          <Select
            value={settings.windowHours}
            onChange={(event) =>
              onChange({ ...settings, windowHours: Number(event.target.value) })
            }
          >
            {ranges
              .sort((a, b) => a - b)
              .map((hours) => (
                <option key={hours} value={hours}>
                  {monitorRangeName(hours, t)}
                </option>
              ))}
          </Select>
        </label>
        <button
          className="button secondary compact"
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          aria-controls="monitor-read-settings"
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          {t("monitorReadSettings")}
        </button>
      </div>
      {open && (
        <ReadSettingsForm
          settings={settings}
          t={t}
          onCancel={() => onOpenChange(false)}
          onApply={(next) => {
            onChange(next);
            onOpenChange(false);
          }}
        />
      )}
    </>
  );
}

function ReadSettingsForm({
  settings,
  t,
  onApply,
  onCancel,
}: {
  settings: MonitorSettings;
  t: Translate;
  onApply: (value: MonitorSettings) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => toDraft(settings));
  useEffect(() => setDraft(toDraft(settings)), [settings]);
  return (
    <form
      id="monitor-read-settings"
      className="monitor-card monitor-read-settings"
      onSubmit={(event) => {
        event.preventDefault();
        if (!event.currentTarget.reportValidity()) return;
        onApply(
          normalizeMonitorSettings(
            Object.fromEntries(
              fields.map(({ key }) => [key, Number(draft[key])]),
            ),
          ),
        );
      }}
    >
      <div className="monitor-settings-heading">
        <h3>{t("monitorReadSettings")}</h3>
        <p>{t("monitorReadSettingsHint")}</p>
      </div>
      <div className="monitor-settings-fields">
        {fields.map(({ key, label, hint }) => {
          const limits = monitorSettingLimits[key];
          const max =
            key === "maxLineMiB"
              ? Math.min(limits.max, Math.max(1, Number(draft.readDepthMiB)))
              : limits.max;
          return (
            <div key={key} className="monitor-setting-field">
              <label htmlFor={`monitor-${key}`}>{t(label)}</label>
              <input
                id={`monitor-${key}`}
                type="number"
                required
                min={limits.min}
                max={max}
                step={1}
                value={draft[key]}
                aria-describedby={`monitor-${key}-hint`}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft((current) => ({ ...current, [key]: value }));
                }}
              />
              <small id={`monitor-${key}-hint`}>
                {t(hint, { min: limits.min, max })}
              </small>
            </div>
          );
        })}
      </div>
      <div className="monitor-settings-actions">
        <button
          type="button"
          className="text-button"
          onClick={() => setDraft(toDraft(defaultMonitorSettings))}
        >
          {t("monitorRestoreDefaults")}
        </button>
        <button
          type="button"
          className="button secondary compact"
          onClick={onCancel}
        >
          {t("cancel")}
        </button>
        <button type="submit" className="button primary compact">
          {t("monitorApplySettings")}
        </button>
      </div>
    </form>
  );
}

export function MonitorCoverageNotice({
  snapshot,
  t,
  onSettings,
}: {
  snapshot: CallMonitorSnapshot;
  t: Translate;
  onSettings: () => void;
}) {
  const { coverage, settings, unreadableFiles } = snapshot;
  const reasons = [
    coverage.omittedFiles > 0 &&
      t("monitorLimitFiles", {
        count: coverage.eligibleFiles,
        limit: settings.maxFiles,
        omitted: coverage.omittedFiles,
      }),
    coverage.depthLimitedFiles > 0 &&
      t("monitorLimitDepth", {
        count: coverage.depthLimitedFiles,
        limit: settings.readDepthMiB,
      }),
    coverage.retentionLimitedFiles > 0 &&
      t("monitorLimitRetention", {
        count: coverage.retentionLimitedFiles,
        limit: settings.maxCallsPerFile,
      }),
    coverage.omittedCalls > 0 &&
      t("monitorLimitCalls", {
        limit: settings.maxCalls,
        count: coverage.omittedCalls,
      }),
    unreadableFiles > 0 && t("monitorUnreadable", { count: unreadableFiles }),
    coverage.invalidLines > 0 &&
      t("monitorInvalidLines", { count: coverage.invalidLines }),
    coverage.oversizedLines > 0 &&
      t("monitorOversizedLines", {
        count: coverage.oversizedLines,
        limit: settings.maxLineMiB,
      }),
  ].filter((reason): reason is string => typeof reason === "string");
  if (!reasons.length) return null;
  const hasIssues =
    unreadableFiles > 0 ||
    coverage.invalidLines > 0 ||
    coverage.oversizedLines > 0;
  return (
    <div
      className={`monitor-notice monitor-coverage${hasIssues ? "" : " is-info"}`}
      role="status"
    >
      <div>
        <strong>
          {t(hasIssues ? "monitorReadIssues" : "monitorReadLimited")}
        </strong>
        <ul>
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        className="button secondary compact"
        onClick={onSettings}
      >
        {t("monitorAdjustSettings")}
      </button>
    </div>
  );
}
