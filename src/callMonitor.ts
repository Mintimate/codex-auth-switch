export type ToolKind = "command" | "fileChange" | "mcp" | "search" | "other";
export type CallStatus =
  "completed" | "failed" | "cancelled" | "pending" | "unknown";

export type MonitorSettings = {
  windowHours: number;
  readDepthMiB: number;
  maxFiles: number;
  maxCallsPerFile: number;
  maxCalls: number;
  maxLineMiB: number;
};
export const defaultMonitorSettings: MonitorSettings = {
  windowHours: 24,
  readDepthMiB: 8,
  maxFiles: 64,
  maxCallsPerFile: 1000,
  maxCalls: 5000,
  maxLineMiB: 1,
};
export const monitorSettingLimits: Record<
  keyof MonitorSettings,
  { min: number; max: number }
> = {
  windowHours: { min: 1, max: 720 },
  readDepthMiB: { min: 1, max: 64 },
  maxFiles: { min: 1, max: 256 },
  maxCallsPerFile: { min: 1, max: 5000 },
  maxCalls: { min: 1, max: 20000 },
  maxLineMiB: { min: 1, max: 8 },
};
export const monitorSettingsStorageKey = "codex-auth-switch.call-monitor.v1";

export function normalizeMonitorSettings(value: unknown): MonitorSettings {
  const result = { ...defaultMonitorSettings };
  if (value && typeof value === "object") {
    for (const key of Object.keys(result) as (keyof MonitorSettings)[]) {
      const input = (value as Record<string, unknown>)[key];
      if (typeof input === "number" && Number.isFinite(input)) {
        const { min, max } = monitorSettingLimits[key];
        result[key] = Math.min(max, Math.max(min, Math.floor(input)));
      }
    }
  }
  result.maxLineMiB = Math.min(result.maxLineMiB, result.readDepthMiB);
  return result;
}

export function loadMonitorSettings(storage?: Pick<Storage, "getItem">) {
  try {
    return normalizeMonitorSettings(
      JSON.parse(storage?.getItem(monitorSettingsStorageKey) ?? "null"),
    );
  } catch {
    return { ...defaultMonitorSettings };
  }
}

export function saveMonitorSettings(
  storage: Pick<Storage, "setItem"> | undefined,
  settings: MonitorSettings,
) {
  try {
    if (!storage) return false;
    storage.setItem(
      monitorSettingsStorageKey,
      JSON.stringify(normalizeMonitorSettings(settings)),
    );
    return true;
  } catch {
    return false;
  }
}

export type MonitorCoverage = {
  eligibleFiles: number;
  omittedFiles: number;
  depthLimitedFiles: number;
  retentionLimitedFiles: number;
  omittedCalls: number;
  invalidLines: number;
  oversizedLines: number;
};
export type ToolCall = {
  id: string;
  sessionId: string;
  turnId: string | null;
  toolId: string;
  kind: ToolKind;
  status: CallStatus;
  source: "executionEvent" | "callRecord";
  observedAtMs: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
  durationMs: number | null;
  exitCode: number | null;
};
export type MonitorSession = {
  id: string;
  parentId: string | null;
  title: string | null;
  project: string | null;
  startedAtMs: number | null;
  lastObservedAtMs: number;
};
export type CallMonitorSnapshot = {
  settings: MonitorSettings;
  coverage: MonitorCoverage;
  calls: ToolCall[];
  sessions: MonitorSession[];
  generatedAtMs: number;
  windowStartMs: number;
  filesScanned: number;
  unreadableFiles: number;
  skippedLines: number;
  limited: boolean;
};

export const toolKinds: ToolKind[] = [
  "command",
  "fileChange",
  "mcp",
  "search",
  "other",
];
export const callStatuses: CallStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "pending",
  "unknown",
];

export function summarizeCalls(calls: ToolCall[]) {
  const timed = calls.filter((call) => call.durationMs !== null);
  return {
    total: calls.length,
    failed: calls.filter((call) => call.status === "failed").length,
    sessions: new Set(calls.map((call) => call.sessionId)).size,
    durationMs: timed.length
      ? timed.reduce((total, call) => total + call.durationMs!, 0)
      : null,
    timed: timed.length,
  };
}

export type CallFilter = {
  session: string;
  turn: string;
  kind: ToolKind | "all";
  status: CallStatus | "all";
};
export const emptyCallFilter: CallFilter = {
  session: "all",
  turn: "all",
  kind: "all",
  status: "all",
};

export function filterCalls(calls: ToolCall[], filter: CallFilter) {
  return calls.filter(
    (call) =>
      (filter.session === "all" || call.sessionId === filter.session) &&
      (filter.turn === "all" || (call.turnId ?? "unknown") === filter.turn) &&
      (filter.kind === "all" || call.kind === filter.kind) &&
      (filter.status === "all" || call.status === filter.status),
  );
}

export function formatCallDuration(ms: number | null, locale: string) {
  if (ms === null) return "—";
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  if (ms < 1000) return `${number.format(ms)} ms`;
  if (ms < 60_000) return `${number.format(ms / 1000)} s`;
  return `${number.format(ms / 60_000)} min`;
}

// 编号基于该会话当前采集范围的时间顺序，不随工具或结果筛选变化。
export function sessionTurns(calls: ToolCall[], sessionId: string) {
  const starts = new Map<string, number>();
  let unknown = false;
  for (const call of calls) {
    if (call.sessionId !== sessionId) continue;
    if (!call.turnId) {
      unknown = true;
      continue;
    }
    const start = call.startedAtMs ?? call.observedAtMs;
    starts.set(call.turnId, Math.min(starts.get(call.turnId) ?? start, start));
  }
  const turns = [...starts]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
  return unknown ? [...turns, "unknown"] : turns;
}

// 仅用于显式演示或本地浏览器预览；与本机会话、账号和网络完全独立。
export function previewCallMonitor(
  now = Date.now(),
  input: MonitorSettings = defaultMonitorSettings,
): CallMonitorSnapshot {
  const settings = normalizeMonitorSettings(input);
  const sessions: MonitorSession[] = [
    {
      id: "a12f40b1c23d8901",
      parentId: null,
      title: "完善登录页面与表单校验",
      project: "sample-dashboard",
      startedAtMs: now - 1_800_000,
      lastObservedAtMs: now - 5_000,
    },
    {
      id: "b80e31a2d94c7102",
      parentId: "a12f40b1c23d8901",
      title: "检查登录接口兼容性",
      project: "sample-dashboard",
      startedAtMs: now - 900_000,
      lastObservedAtMs: now - 18_000,
    },
    {
      id: "c94b63d3e80f1203",
      parentId: null,
      title: "修复移动端导航布局",
      project: "docs-site",
      startedAtMs: now - 3_600_000,
      lastObservedAtMs: now - 120_000,
    },
  ];
  const calls: ToolCall[] = Array.from({ length: 28 }, (_, index) => {
    const session = sessions[index % sessions.length];
    const kind = toolKinds[index % 5];
    const end = now - (index + 1) * 12_000;
    const duration = [1834, 215, 3280, 14500, 720][index % 5];
    return {
      id: `demo-call-${index}`,
      sessionId: session.id,
      turnId: `demo-turn-${index % 6}`,
      toolId: kind === "mcp" ? "f36b41e9" : kind,
      kind,
      status:
        index === 6 || index === 17
          ? "failed"
          : index === 0
            ? "pending"
            : index === 9
              ? "unknown"
              : "completed",
      source: kind === "other" ? "callRecord" : "executionEvent",
      observedAtMs: end,
      startedAtMs: end - duration,
      completedAtMs: index === 0 ? null : end,
      durationMs: index === 0 || kind === "other" ? null : duration,
      exitCode: kind === "command" && index !== 0 ? 0 : null,
    };
  });
  const selectedSessions = sessions.slice(0, settings.maxFiles);
  const selectedIds = new Set(selectedSessions.map((session) => session.id));
  const counts = new Map<string, number>();
  const cappedSessions = new Set<string>();
  const windowStartMs = now - settings.windowHours * 3_600_000;
  const retained = calls.filter((call) => {
    if (call.observedAtMs < windowStartMs || !selectedIds.has(call.sessionId))
      return false;
    const count = (counts.get(call.sessionId) ?? 0) + 1;
    counts.set(call.sessionId, count);
    if (count > settings.maxCallsPerFile) cappedSessions.add(call.sessionId);
    return count <= settings.maxCallsPerFile;
  });
  const coverage: MonitorCoverage = {
    eligibleFiles: sessions.length,
    omittedFiles: sessions.length - selectedSessions.length,
    depthLimitedFiles: 0,
    retentionLimitedFiles: cappedSessions.size,
    omittedCalls: Math.max(0, retained.length - settings.maxCalls),
    invalidLines: 0,
    oversizedLines: 0,
  };
  return {
    settings,
    coverage,
    calls: retained.slice(0, settings.maxCalls),
    sessions: selectedSessions,
    generatedAtMs: now,
    windowStartMs,
    filesScanned: selectedSessions.length,
    unreadableFiles: 0,
    skippedLines: 0,
    limited:
      coverage.omittedFiles > 0 ||
      coverage.retentionLimitedFiles > 0 ||
      coverage.omittedCalls > 0,
  };
}
