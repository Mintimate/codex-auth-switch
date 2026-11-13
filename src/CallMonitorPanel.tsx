import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpLeft,
  Braces,
  ChevronDown,
  Clock3,
  FilePenLine,
  GitBranch,
  Layers3,
  Network,
  Pause,
  Play,
  RefreshCw,
  Search,
  Terminal,
  Workflow,
} from "lucide-react";
import { getCallMonitor } from "./api";
import {
  callStatuses,
  emptyCallFilter,
  defaultMonitorSettings,
  loadMonitorSettings,
  saveMonitorSettings,
  normalizeMonitorSettings,
  filterCalls,
  formatCallDuration,
  sessionTurns,
  summarizeCalls,
  toolKinds,
  type CallFilter,
  type CallMonitorSnapshot,
  type CallStatus,
  type ToolCall,
  type ToolKind,
  type MonitorSettings,
} from "./callMonitor";
import type { Locale, MessageKey, Translate } from "./i18n";
import { isBrowserPreview } from "./runtime";
import { Select } from "./Select";
import {
  MonitorCoverageNotice,
  MonitorReadControls,
  monitorRangeName,
} from "./MonitorReadControls";
import "./CallMonitorPanel.css";

const kindKeys: Record<ToolKind, MessageKey> = {
  command: "monitorCommand",
  fileChange: "monitorFileChange",
  mcp: "monitorMcp",
  search: "monitorSearch",
  other: "monitorOther",
};
const statusKeys: Record<CallStatus, MessageKey> = {
  completed: "monitorCompleted",
  failed: "monitorFailed",
  cancelled: "monitorCancelled",
  pending: "monitorPending",
  unknown: "monitorUnknown",
};
const icons = {
  command: Terminal,
  fileChange: FilePenLine,
  mcp: Network,
  search: Search,
  other: Braces,
};

function ToolIcon({ kind }: { kind: ToolKind }) {
  const Icon = icons[kind];
  return <Icon size={17} aria-hidden="true" />;
}

function StatusBadge({ status, t }: { status: CallStatus; t: Translate }) {
  return (
    <span className={`monitor-status is-${status}`}>
      <i aria-hidden="true" />
      {t(statusKeys[status])}
    </span>
  );
}

type PanelProps = { locale: Locale; t: Translate; privateMode: boolean };

export function CallMonitorPanel(props: PanelProps) {
  const [settings, setSettings] = useState(() => {
    try {
      return loadMonitorSettings(window.localStorage);
    } catch {
      return { ...defaultMonitorSettings };
    }
  });
  const settingsRef = useRef(settings);
  const [saveError, setSaveError] = useState(false);
  const [snapshot, setSnapshot] = useState<CallMonitorSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [auto, setAuto] = useState(true);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const preview = isBrowserPreview();
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    let requested: MonitorSettings;
    // 设置改变时丢弃旧请求结果，并在完成后读取最新设置，避免请求竞态。
    do {
      requested = settingsRef.current;
      try {
        const next = await getCallMonitor(requested);
        if (mounted.current && requested === settingsRef.current) {
          setSnapshot(next);
          setError(false);
        }
      } catch {
        if (mounted.current && requested === settingsRef.current)
          setError(true);
      }
    } while (mounted.current && requested !== settingsRef.current);
    inFlight.current = false;
    if (mounted.current) setLoading(false);
  }, []);
  const changeSettings = (value: MonitorSettings) => {
    const next = normalizeMonitorSettings(value);
    settingsRef.current = next;
    setSettings(next);
    setSnapshot(null);
    setError(false);
    try {
      setSaveError(!saveMonitorSettings(window.localStorage, next));
    } catch {
      setSaveError(true);
    }
    void refresh();
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!auto || preview) return;
    let disposed = false;
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      if (disposed || document.visibilityState === "hidden") return;
      timer = window.setTimeout(async () => {
        if (document.visibilityState !== "hidden") await refresh();
        schedule();
      }, 3000);
    };
    const visibility = () => {
      window.clearTimeout(timer);
      if (document.visibilityState !== "hidden") void refresh().then(schedule);
    };
    schedule();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [auto, preview, refresh]);
  return (
    <CallMonitorView
      {...props}
      snapshot={snapshot}
      loading={loading}
      error={error}
      auto={auto}
      preview={preview}
      settings={settings}
      onSettingsChange={changeSettings}
      saveError={saveError}
      onAutoChange={setAuto}
      onRefresh={() => void refresh()}
    />
  );
}

type ViewProps = PanelProps & {
  settings?: MonitorSettings;
  onSettingsChange?: (value: MonitorSettings) => void;
  saveError?: boolean;
  snapshot: CallMonitorSnapshot | null;
  loading: boolean;
  error: boolean;
  auto: boolean;
  preview: boolean;
  onAutoChange: (value: boolean) => void;
  onRefresh: () => void;
};

export function CallMonitorView({
  snapshot,
  loading,
  error,
  auto,
  preview,
  onAutoChange,
  onRefresh,
  locale,
  t,
  privateMode,
  settings = defaultMonitorSettings,
  onSettingsChange = () => {},
  saveError = false,
}: ViewProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filter, setFilter] = useState<CallFilter>(emptyCallFilter);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [limit, setLimit] = useState(60);
  const calls = snapshot?.calls ?? [];
  const sessions = snapshot?.sessions ?? [];
  const summary = useMemo(() => summarizeCalls(calls), [calls]);
  const filtered = useMemo(() => filterCalls(calls, filter), [calls, filter]);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const time = (value: number | null) =>
    value === null
      ? "—"
      : new Date(value).toLocaleTimeString(locale, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
  const fullTime = (value: number | null) =>
    value === null
      ? t("monitorNotRecorded")
      : new Date(value).toLocaleString(locale);
  const sessionLabels = new Map(
    sessions.map((session, index) => {
      const anonymous = t("monitorSessionName", { id: index + 1 });
      const started = session.startedAtMs ?? session.lastObservedAtMs;
      const date = started
        ? new Date(started).toLocaleString(locale, {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })
        : "";
      const name = privateMode
        ? anonymous
        : session.title || session.project || t("monitorLocalSession");
      const detail = privateMode
        ? ""
        : [session.title ? session.project : null, date]
            .filter(Boolean)
            .join(" · ");
      return [
        session.id,
        { name, detail, option: [name, detail].filter(Boolean).join(" · ") },
      ] as const;
    }),
  );
  const sessionName = (id: string) =>
    sessionLabels.get(id)?.name ?? t("monitorLocalSession");
  const sessionDescription = (id: string) =>
    sessionLabels.get(id)?.detail ?? "";
  const sessionOption = (id: string) =>
    sessionLabels.get(id)?.option ?? t("monitorLocalSession");
  const sessionIds = new Set(calls.map((call) => call.sessionId));
  const selectableSessions = sessions.filter((session) =>
    sessionIds.has(session.id),
  );
  const graphSession =
    selectableSessions.find((session) => session.id === filter.session) ??
    selectableSessions[0];
  const graphCalls = calls.filter(
    (call) => call.sessionId === graphSession?.id,
  );
  const turnsBySession = useMemo(
    () =>
      new Map(
        sessions.map((session) => [
          session.id,
          sessionTurns(calls, session.id),
        ]),
      ),
    [calls, sessions],
  );
  const allTurns = turnsBySession.get(graphSession?.id ?? "") ?? [];
  const turns = allTurns.slice(-4);
  const turnName = (id: string | null, sessionId = graphSession?.id ?? "") =>
    !id || id === "unknown"
      ? t("monitorUnknownTurn")
      : t("monitorTurnName", {
          id: (turnsBySession.get(sessionId)?.indexOf(id) ?? -1) + 1,
        });
  const graphKinds = toolKinds.filter((kind) =>
    graphCalls.some((call) => call.kind === kind),
  );
  const graphHeight = Math.max(turns.length, graphKinds.length, 3) * 64 + 16;
  const nodeY = (index: number, count: number) =>
    (graphHeight - count * 64) / 2 + index * 64 + 8;
  const related = graphSession
    ? sessions.filter((session) => session.parentId === graphSession.id)
    : [];
  useEffect(() => {
    setLimit(60);
  }, [filter]);
  // 记录滚出 24 小时窗口后恢复可见筛选，避免留下失效的隐藏条件。
  useEffect(() => {
    if (!snapshot) return;
    setFilter((current) => {
      if (
        current.session !== "all" &&
        !snapshot.calls.some((call) => call.sessionId === current.session)
      )
        return { ...current, session: "all", turn: "all" };
      if (
        current.turn !== "all" &&
        !snapshot.calls.some(
          (call) =>
            call.sessionId === current.session &&
            (call.turnId ?? "unknown") === current.turn,
        )
      )
        return { ...current, turn: "all" };
      return current;
    });
  }, [snapshot]);
  const selectSession = (session: string) =>
    setFilter((current) => ({ ...current, session, turn: "all" }));
  const selectKind = (kind: ToolKind) =>
    setFilter((current) => ({
      ...current,
      kind: current.kind === kind ? "all" : kind,
    }));

  return (
    <section className="monitor-page">
      <div className="monitor-heading page-heading">
        <div>
          <span className="eyebrow">{t("monitorEyebrow")}</span>
          <h2>{t("monitorTab")}</h2>
          <p>{t("monitorDescription")}</p>
        </div>
        <div className="monitor-actions">
          <span
            className={`monitor-live${auto && !preview && !error ? " enabled" : ""}`}
          >
            <i aria-hidden="true" />
            {t(
              preview
                ? "monitorDemo"
                : error
                  ? "monitorUpdateFailed"
                  : auto
                    ? "monitorAuto"
                    : "monitorPaused",
            )}
          </span>
          {!preview && (
            <button
              type="button"
              className="button secondary compact"
              onClick={() => onAutoChange(!auto)}
              aria-label={t(auto ? "monitorPause" : "monitorResume")}
              title={t(auto ? "monitorPause" : "monitorResume")}
            >
              {auto ? <Pause size={15} /> : <Play size={15} />}
            </button>
          )}
          <button
            type="button"
            className="button secondary compact"
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw
              size={15}
              className={loading ? "monitor-refreshing" : ""}
              aria-hidden="true"
            />
            {t("refresh")}
          </button>
        </div>
      </div>

      <MonitorReadControls
        settings={settings}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onChange={onSettingsChange}
        t={t}
      />
      {saveError && (
        <p className="monitor-save-error" role="alert">
          {t("monitorSaveFailed")}
        </p>
      )}
      {error && (
        <div className="monitor-notice is-error" role="alert">
          <span>{t(snapshot ? "monitorStale" : "monitorReadFailed")}</span>
          <button
            type="button"
            className="text-button"
            disabled={loading}
            onClick={onRefresh}
          >
            {t("retry")}
          </button>
        </div>
      )}
      {snapshot && (
        <MonitorCoverageNotice
          snapshot={snapshot}
          t={t}
          onSettings={() => setSettingsOpen(true)}
        />
      )}

      {!snapshot ? (
        <div className="monitor-empty" role="status">
          <Activity size={30} aria-hidden="true" />
          <strong>{t(loading ? "monitorLoading" : "monitorReadFailed")}</strong>
          <p>{t("monitorEmptyHint")}</p>
        </div>
      ) : (
        <>
          <div className="monitor-range">
            <span>
              {t("monitorWindow", {
                range: monitorRangeName(snapshot.settings.windowHours, t),
              })}
            </span>
            <span>
              {t("monitorUpdated", { time: time(snapshot.generatedAtMs) })}
            </span>
          </div>
          {(snapshot.filesScanned > 0 || snapshot.unreadableFiles === 0) && (
            <div className="monitor-metrics">
              <article className="monitor-metric is-primary">
                <span>
                  <Workflow size={17} aria-hidden="true" />
                  {t("monitorTotal")}
                </span>
                <strong>{number(summary.total)}</strong>
                <small>{t("monitorTotalHint")}</small>
              </article>
              <article className="monitor-metric">
                <span>
                  <Activity size={17} aria-hidden="true" />
                  {t("monitorFailures")}
                </span>
                <strong className={summary.failed ? "has-failures" : ""}>
                  {number(summary.failed)}
                </strong>
                <small>{t("monitorFailureHint")}</small>
              </article>
              <article className="monitor-metric">
                <span>
                  <Clock3 size={17} aria-hidden="true" />
                  {t("monitorDuration")}
                </span>
                <strong>
                  {formatCallDuration(summary.durationMs, locale)}
                </strong>
                <small>
                  {t("monitorDurationHint", { count: summary.timed })}
                </small>
              </article>
              <article className="monitor-metric">
                <span>
                  <Layers3 size={17} aria-hidden="true" />
                  {t("monitorSessions")}
                </span>
                <strong>{number(summary.sessions)}</strong>
                <small>{t("monitorSessionsHint")}</small>
              </article>
            </div>
          )}

          {calls.length === 0 ? (
            <div className="monitor-empty">
              <Workflow size={32} aria-hidden="true" />
              <strong>
                {t(
                  snapshot.unreadableFiles
                    ? "monitorSourceUnavailable"
                    : "monitorEmpty",
                )}
              </strong>
              <p>
                {t(
                  snapshot.unreadableFiles
                    ? "monitorReadFailed"
                    : "monitorEmptyHint",
                )}
              </p>
              <button
                type="button"
                className="button secondary"
                disabled={loading}
                onClick={onRefresh}
              >
                {t("refresh")}
              </button>
            </div>
          ) : (
            <>
              <div className="monitor-overview">
                <article className="monitor-card monitor-graph-card">
                  <header className="monitor-card-heading">
                    <div>
                      <h3>
                        <GitBranch size={18} aria-hidden="true" />
                        {t("monitorGraph")}
                      </h3>
                      <p>{t("monitorGraphHint")}</p>
                    </div>
                    <div className="monitor-graph-picker">
                      <Select
                        aria-label={t("monitorGraphSessionSelect")}
                        value={graphSession?.id ?? ""}
                        onChange={(event) => selectSession(event.target.value)}
                      >
                        {selectableSessions.map((session) => (
                          <option key={session.id} value={session.id}>
                            {sessionOption(session.id)}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </header>
                  <div className="monitor-graph-scroll">
                    <div className="monitor-graph-labels">
                      <span>{t("monitorGraphSession")}</span>
                      <span>{t("monitorGraphTurns")}</span>
                      <span>{t("monitorGraphTools")}</span>
                    </div>
                    <div
                      className="monitor-flow"
                      style={{ height: graphHeight }}
                    >
                      <svg
                        className="monitor-edges"
                        viewBox={`0 0 1000 ${graphHeight}`}
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        {turns.map((turn, index) => (
                          <path
                            key={`session-${turn}`}
                            className={filter.turn === turn ? "selected" : ""}
                            d={`M 280 ${graphHeight / 2} C 325 ${graphHeight / 2}, 315 ${nodeY(index, turns.length) + 24}, 360 ${nodeY(index, turns.length) + 24}`}
                          />
                        ))}
                        {turns.flatMap((turn, index) =>
                          graphKinds
                            .filter((kind) =>
                              graphCalls.some(
                                (call) =>
                                  (call.turnId ?? "unknown") === turn &&
                                  call.kind === kind,
                              ),
                            )
                            .map((kind) => (
                              <path
                                key={`${turn}-${kind}`}
                                className={
                                  filter.turn === turn || filter.kind === kind
                                    ? "selected"
                                    : ""
                                }
                                d={`M 640 ${nodeY(index, turns.length) + 24} C 680 ${nodeY(index, turns.length) + 24}, 680 ${nodeY(graphKinds.indexOf(kind), graphKinds.length) + 24}, 720 ${nodeY(graphKinds.indexOf(kind), graphKinds.length) + 24}`}
                              />
                            )),
                        )}
                      </svg>
                      {graphSession && (
                        <button
                          type="button"
                          className={`monitor-node monitor-session-node${filter.session === graphSession.id ? " selected" : ""}`}
                          style={{ top: graphHeight / 2 - 43 }}
                          onClick={() => selectSession(graphSession.id)}
                          aria-pressed={filter.session === graphSession.id}
                          title={sessionOption(graphSession.id)}
                        >
                          <Workflow size={23} aria-hidden="true" />
                          <span>
                            <strong>{sessionName(graphSession.id)}</strong>
                            {sessionDescription(graphSession.id) && (
                              <small>
                                {sessionDescription(graphSession.id)}
                              </small>
                            )}
                            <small>
                              {t("monitorCallCount", {
                                count: graphCalls.length,
                              })}
                            </small>
                          </span>
                        </button>
                      )}
                      {turns.map((turn, index) => (
                        <button
                          type="button"
                          key={turn}
                          className={`monitor-node monitor-turn-node${filter.turn === turn ? " selected" : ""}`}
                          style={{ top: nodeY(index, turns.length) }}
                          aria-pressed={filter.turn === turn}
                          onClick={() =>
                            setFilter((current) => ({
                              ...current,
                              session: graphSession.id,
                              turn: current.turn === turn ? "all" : turn,
                            }))
                          }
                        >
                          <Layers3 size={16} aria-hidden="true" />
                          <span>{turnName(turn)}</span>
                          <small>
                            {
                              graphCalls.filter(
                                (call) => (call.turnId ?? "unknown") === turn,
                              ).length
                            }
                          </small>
                        </button>
                      ))}
                      {graphKinds.map((kind, index) => (
                        <button
                          type="button"
                          key={kind}
                          className={`monitor-node monitor-tool-node${filter.kind === kind ? " selected" : ""}`}
                          style={{ top: nodeY(index, graphKinds.length) }}
                          aria-pressed={filter.kind === kind}
                          onClick={() => {
                            setFilter((current) => ({
                              ...current,
                              session: graphSession.id,
                              turn:
                                current.session === graphSession.id
                                  ? current.turn
                                  : "all",
                              kind: current.kind === kind ? "all" : kind,
                            }));
                          }}
                        >
                          <ToolIcon kind={kind} />
                          <span>{t(kindKeys[kind])}</span>
                          <small>
                            {
                              graphCalls.filter((call) => call.kind === kind)
                                .length
                            }
                          </small>
                        </button>
                      ))}
                    </div>
                  </div>
                  {graphSession &&
                    (graphSession.parentId || related.length > 0) && (
                      <div className="monitor-relations">
                        <span>{t("monitorRelated")}</span>
                        {graphSession.parentId &&
                          (sessionIds.has(graphSession.parentId) ? (
                            <button
                              type="button"
                              onClick={() =>
                                selectSession(graphSession.parentId!)
                              }
                            >
                              <ArrowUpLeft size={14} />
                              {t("monitorParent")}
                              {" · "}
                              {sessionOption(graphSession.parentId)}
                            </button>
                          ) : (
                            <span>{t("monitorParentOutside")}</span>
                          ))}
                        {related.map((child) => (
                          <button
                            type="button"
                            key={child.id}
                            disabled={!sessionIds.has(child.id)}
                            onClick={() => selectSession(child.id)}
                          >
                            <ArrowDownRight size={14} />
                            {sessionOption(child.id)}
                          </button>
                        ))}
                      </div>
                    )}
                </article>
                <article className="monitor-card monitor-tools">
                  <header className="monitor-card-heading">
                    <div>
                      <h3>
                        <Network size={18} aria-hidden="true" />
                        {t("monitorToolOverview")}
                      </h3>
                      <p>{t("monitorToolOverviewHint")}</p>
                    </div>
                  </header>
                  {toolKinds.map((kind) => {
                    const group = calls.filter((call) => call.kind === kind);
                    const latest = group[0];
                    return (
                      <button
                        type="button"
                        key={kind}
                        disabled={!latest}
                        className={`monitor-tool-summary${filter.kind === kind ? " selected" : ""}`}
                        onClick={() => selectKind(kind)}
                        aria-pressed={filter.kind === kind}
                      >
                        <span className="monitor-tool-summary-name">
                          <ToolIcon kind={kind} />
                          <strong>{t(kindKeys[kind])}</strong>
                          <b>{number(group.length)}</b>
                        </span>
                        <span className="monitor-tool-summary-meta">
                          {latest ? (
                            <StatusBadge status={latest.status} t={t} />
                          ) : (
                            <span>{t("monitorNoCalls")}</span>
                          )}
                          <span>
                            {latest ? time(latest.observedAtMs) : "—"}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </article>
              </div>

              <article className="monitor-card monitor-timeline">
                <header className="monitor-card-heading">
                  <div>
                    <h3>
                      <Clock3 size={18} aria-hidden="true" />
                      {t("monitorTimeline")}
                    </h3>
                    <p>
                      {t("monitorTimelineHint", {
                        count: filtered.length,
                        total: calls.length,
                      })}
                    </p>
                  </div>
                  {Object.entries(filter).some(
                    ([, value]) => value !== "all",
                  ) && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setFilter(emptyCallFilter)}
                    >
                      {t("monitorReset")}
                    </button>
                  )}
                </header>
                <div className="monitor-filters">
                  <label>
                    <span>{t("monitorGraphSession")}</span>
                    <Select
                      value={filter.session}
                      onChange={(event) => selectSession(event.target.value)}
                    >
                      <option value="all">{t("monitorAllSessions")}</option>
                      {selectableSessions.map((session) => (
                        <option key={session.id} value={session.id}>
                          {sessionOption(session.id)}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label>
                    <span>{t("monitorToolType")}</span>
                    <Select
                      value={filter.kind}
                      onChange={(event) =>
                        setFilter((current) => ({
                          ...current,
                          kind: event.target.value as CallFilter["kind"],
                        }))
                      }
                    >
                      <option value="all">{t("monitorAllTools")}</option>
                      {toolKinds.map((kind) => (
                        <option key={kind} value={kind}>
                          {t(kindKeys[kind])}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label>
                    <span>{t("monitorStatus")}</span>
                    <Select
                      value={filter.status}
                      onChange={(event) =>
                        setFilter((current) => ({
                          ...current,
                          status: event.target.value as CallFilter["status"],
                        }))
                      }
                    >
                      <option value="all">{t("monitorAllStatuses")}</option>
                      {callStatuses.map((status) => (
                        <option key={status} value={status}>
                          {t(statusKeys[status])}
                        </option>
                      ))}
                    </Select>
                  </label>
                  {filter.turn !== "all" && (
                    <button
                      type="button"
                      className="monitor-turn-filter"
                      onClick={() =>
                        setFilter((current) => ({ ...current, turn: "all" }))
                      }
                    >
                      {turnName(filter.turn)} ×
                    </button>
                  )}
                </div>
                {filtered.length === 0 ? (
                  <div className="monitor-filter-empty">
                    {t("monitorNoMatches")}
                  </div>
                ) : (
                  <div className="monitor-table-scroll">
                    <table className="monitor-table">
                      <thead>
                        <tr>
                          <th>{t("monitorToolType")}</th>
                          <th>{t("monitorGraphSession")}</th>
                          <th>{t("monitorStatus")}</th>
                          <th>{t("monitorElapsed")}</th>
                          <th>{t("monitorObserved")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.slice(0, limit).map((call) => (
                          <CallRows
                            key={call.id}
                            call={call}
                            expanded={expanded === call.id}
                            onToggle={() =>
                              setExpanded(expanded === call.id ? null : call.id)
                            }
                            sessionName={sessionName(call.sessionId)}
                            sessionDescription={sessionDescription(
                              call.sessionId,
                            )}
                            turnName={turnName(call.turnId, call.sessionId)}
                            locale={locale}
                            t={t}
                            privateMode={privateMode}
                            time={time}
                            fullTime={fullTime}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {filtered.length > limit && (
                  <button
                    type="button"
                    className="monitor-more text-button"
                    onClick={() => setLimit((value) => value + 60)}
                  >
                    {t("monitorMore", { count: filtered.length - limit })}
                  </button>
                )}
              </article>
            </>
          )}
          <details className="monitor-explanation">
            <summary>{t("monitorAbout")}</summary>
            <p>{t("monitorPrivacyHint")}</p>
            <p>{t("monitorSourceHint")}</p>
            <p>{t("monitorTimingHint")}</p>
            <p>
              {t("monitorReadScope", {
                count: snapshot.filesScanned,
                files: snapshot.settings.maxFiles,
                depth: snapshot.settings.readDepthMiB,
                calls: snapshot.settings.maxCalls,
              })}
            </p>
          </details>
        </>
      )}
    </section>
  );
}

function CallRows({
  call,
  expanded,
  onToggle,
  sessionName,
  sessionDescription,
  turnName,
  locale,
  t,
  privateMode,
  time,
  fullTime,
}: {
  call: ToolCall;
  expanded: boolean;
  onToggle: () => void;
  sessionName: string;
  sessionDescription: string;
  turnName: string;
  locale: Locale;
  t: Translate;
  privateMode: boolean;
  time: (value: number | null) => string;
  fullTime: (value: number | null) => string;
}) {
  return (
    <>
      <tr className={expanded ? "expanded" : ""}>
        <td>
          <button
            type="button"
            className="monitor-call-toggle"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={`call-${call.id}`}
          >
            <ToolIcon kind={call.kind} />
            <span>{t(kindKeys[call.kind])}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </td>
        <td>
          <span
            className="monitor-session-cell"
            title={[sessionName, sessionDescription]
              .filter(Boolean)
              .join(" · ")}
          >
            <strong>{sessionName}</strong>
            {sessionDescription && <small>{sessionDescription}</small>}
          </span>
        </td>
        <td>
          <StatusBadge status={call.status} t={t} />
        </td>
        <td className="monitor-number">
          {formatCallDuration(call.durationMs, locale)}
        </td>
        <td className="monitor-number">{time(call.observedAtMs)}</td>
      </tr>
      {expanded && (
        <tr className="monitor-detail-row" id={`call-${call.id}`}>
          <td colSpan={5}>
            <dl>
              <div>
                <dt>{t("monitorStarted")}</dt>
                <dd>{fullTime(call.startedAtMs)}</dd>
              </div>
              <div>
                <dt>{t("monitorEnded")}</dt>
                <dd>{fullTime(call.completedAtMs)}</dd>
              </div>
              <div>
                <dt>{t("monitorSource")}</dt>
                <dd>
                  {t(
                    call.source === "executionEvent"
                      ? "monitorExecutionSource"
                      : "monitorRecordSource",
                  )}
                </dd>
              </div>
              <div>
                <dt>{t("monitorExitCode")}</dt>
                <dd>{call.exitCode === null ? "—" : call.exitCode}</dd>
              </div>
              <div>
                <dt>{t("monitorGraphTurns")}</dt>
                <dd>{turnName}</dd>
              </div>
              {!privateMode && (
                <>
                  <div>
                    <dt>{t("monitorToolId")}</dt>
                    <dd>{call.toolId.slice(0, 16)}</dd>
                  </div>
                </>
              )}
            </dl>
            <p>
              {t(
                call.source === "callRecord"
                  ? "monitorFallbackHint"
                  : "monitorDetailHint",
              )}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}
