import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let ipcCalls = 0;
globalThis.window = {
  __TAURI_INTERNALS__: { invoke() { ipcCalls++; throw new Error("Unexpected IPC"); } },
};
const server = await createServer({
  mode: "demo",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
after(async () => { await server.close(); delete globalThis.window; });
const api = await server.ssrLoadModule("/src/api.ts");
const model = await server.ssrLoadModule("/src/callMonitor.ts");
const { CallMonitorView } = await server.ssrLoadModule("/src/CallMonitorPanel.tsx");
const { MonitorCoverageNotice, MonitorReadControls } = await server.ssrLoadModule("/src/MonitorReadControls.tsx");
const { default: messages } = await server.ssrLoadModule("/src/locales/zh-CN.json");
const t = (key, values = {}) => {
  assert.equal(typeof messages[key], "string", `Missing translation: ${key}`);
  return Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), messages[key]);
};
const demo = model.previewCallMonitor(1_800_000_000_000);
const render = (overrides = {}) => renderToStaticMarkup(createElement(CallMonitorView, {
  snapshot: demo, loading: false, error: false, auto: true, preview: true,
  onAutoChange() {}, onRefresh() {}, locale: "zh-CN", t, privateMode: false, ...overrides,
}));

test("公开演示读取独立虚构调用，无 IPC 或数据污染", async () => {
  const first = await api.getCallMonitor();
  assert.ok(first.calls.length > 0);
  first.calls.length = 0;
  assert.ok((await api.getCallMonitor()).calls.length > 0);
  assert.equal(ipcCalls, 0);
});

test("耗时未知不会成为零，未见结果不计为失败", () => {
  const calls = demo.calls.slice(0, 2).map((call) => ({ ...call, durationMs: null, status: "pending" }));
  assert.equal(model.summarizeCalls(calls).durationMs, null);
  assert.equal(model.summarizeCalls(calls).failed, 0);
  assert.equal(model.formatCallDuration(null, "zh-CN"), "—");
  assert.equal(model.formatCallDuration(0, "zh-CN"), "0 ms");
});

test("会话、轮次、类型和结果筛选同时生效，未知轮次可单独筛选", () => {
  const selected = demo.calls[6];
  const filter = { session: selected.sessionId, turn: selected.turnId, kind: selected.kind, status: "failed" };
  assert.deepEqual(model.filterCalls(demo.calls, filter), [selected]);
  const unknown = { ...selected, turnId: null };
  assert.deepEqual(model.filterCalls([unknown], { ...filter, turn: "unknown" }), [unknown]);
  assert.equal(model.filterCalls(demo.calls, model.emptyCallFilter).length, demo.calls.length);
});

test("加载和读取失败不显示空数据或零值指标", () => {
  const loading = render({ snapshot: null, loading: true });
  assert.ok(loading.includes(t("monitorLoading")));
  assert.ok(!loading.includes(t("monitorEmpty")));
  const failed = render({ snapshot: null, error: true });
  assert.ok(failed.includes(t("monitorReadFailed")));
  assert.ok(!failed.includes('class="monitor-metrics"'));
});

test("刷新失败保留已有图表并明确标记旧记录，空态给出下一步", () => {
  const failed = render({ error: true });
  assert.ok(failed.includes(t("monitorStale")));
  assert.ok(failed.includes('class="monitor-metrics"'));
  const empty = render({ snapshot: { ...demo, calls: [], sessions: [] } });
  assert.ok(empty.includes(t("monitorEmpty")));
  assert.ok(empty.includes(t("monitorEmptyHint")));
  assert.ok(!empty.includes('class="monitor-flow"'));
});

test("截断和读取失败显式提示，已有记录仍可查看", () => {
  const html = render({ snapshot: { ...demo, limited: true, unreadableFiles: 2, skippedLines: 1,
    coverage: { ...demo.coverage, depthLimitedFiles: 1, invalidLines: 1 },
  } });
  assert.ok(html.includes(t("monitorReadIssues")));
  assert.ok(html.includes(t("monitorUnreadable", { count: 2 })));
  assert.ok(html.includes(t("monitorInvalidLines", { count: 1 })));
  assert.ok(html.includes(t("monitorLimitDepth", { count: 1, limit: demo.settings.readDepthMiB })));
  assert.ok(html.includes(t("monitorTimeline")));
  const unavailable = render({ snapshot: { ...demo, calls: [], sessions: [], filesScanned: 0, unreadableFiles: 1 } });
  assert.ok(unavailable.includes(t("monitorSourceUnavailable")));
  assert.ok(!unavailable.includes('class="monitor-metrics"'));
});

test("无异常不提示，零计数不显示；超长记录与解析失败分别提示", () => {
  const notice = snapshot => renderToStaticMarkup(createElement(MonitorCoverageNotice, { snapshot, t, onSettings() {} }));
  assert.equal(notice(demo), "");
  const html = notice({ ...demo, skippedLines: 1, coverage: { ...demo.coverage, oversizedLines: 1 } });
  assert.ok(html.includes(t("monitorOversizedLines", { count: 1, limit: demo.settings.maxLineMiB })));
  assert.ok(!html.includes(t("monitorUnreadable", { count: 0 })));
  assert.ok(!html.includes(t("monitorInvalidLines", { count: 0 })));
  assert.ok(!html.includes(t("monitorLimitCalls", { limit: demo.settings.maxCalls, count: 0 })));
});

test("每一项读取上限都显示原因、当前阈值和可调整入口", () => {
  const snapshot = { ...demo, coverage: { ...demo.coverage,
    eligibleFiles: 80, omittedFiles: 16, depthLimitedFiles: 2, retentionLimitedFiles: 1, omittedCalls: 7,
  } };
  const html = render({ snapshot });
  assert.ok(html.includes(t("monitorLimitFiles", { count: 80, limit: 64, omitted: 16 })));
  assert.ok(html.includes(t("monitorLimitDepth", { count: 2, limit: 8 })));
  assert.ok(html.includes(t("monitorLimitRetention", { count: 1, limit: 1000 })));
  assert.ok(html.includes(t("monitorLimitCalls", { limit: 5000, count: 7 })));
  assert.ok(html.includes(t("monitorAdjustSettings")));
  assert.ok(!html.includes(t("monitorReadIssues")));
});

test("本地设置可保存恢复，非法值受限，损坏或不可用存储不阻断页面", () => {
  let stored;
  const storage = { getItem: () => stored, setItem: (_key, value) => { stored = value; } };
  const settings = { ...model.defaultMonitorSettings, windowHours: 6, readDepthMiB: 32, maxCalls: 9000 };
  assert.equal(model.saveMonitorSettings(storage, settings), true);
  assert.deepEqual(model.loadMonitorSettings(storage), settings);
  stored = "invalid json";
  assert.deepEqual(model.loadMonitorSettings(storage), model.defaultMonitorSettings);
  assert.deepEqual(model.loadMonitorSettings({ getItem() { throw Error("blocked"); } }), model.defaultMonitorSettings);
  assert.equal(model.saveMonitorSettings({ setItem() { throw Error("blocked"); } }, settings), false);
  const bounded = model.normalizeMonitorSettings({ windowHours: 0, readDepthMiB: 2, maxLineMiB: 9, maxFiles: 999, maxCalls: Infinity, extra: "PRIVATE_TOKEN" });
  assert.equal(bounded.windowHours, 1);
  assert.equal(bounded.maxFiles, 256);
  assert.equal(bounded.maxLineMiB, 2);
  assert.equal(bounded.maxCalls, model.defaultMonitorSettings.maxCalls);
  assert.ok(!JSON.stringify(bounded).includes("PRIVATE_TOKEN"));
});

test("演示接口接收时间范围和上限，按最新调用截断并保留独立数据", async () => {
  const settings = { ...model.defaultMonitorSettings, windowHours: 6, maxFiles: 1, maxCallsPerFile: 4, maxCalls: 3 };
  const snapshot = await api.getCallMonitor(settings);
  assert.equal(snapshot.calls.length, 3);
  assert.equal(snapshot.settings.windowHours, 6);
  assert.equal(snapshot.generatedAtMs - snapshot.windowStartMs, 6 * 3_600_000);
  assert.equal(snapshot.coverage.omittedFiles, 2);
  assert.equal(snapshot.coverage.retentionLimitedFiles, 1);
  assert.equal(snapshot.coverage.omittedCalls, 1);
  assert.ok(snapshot.calls.every((call, index) => !index || call.observedAtMs <= snapshot.calls[index - 1].observedAtMs));
  assert.equal((await api.getCallMonitor()).calls.length, 28);
  assert.equal(ipcCalls, 0);
});

test("读取设置包含自定义时间与所有上限，保存失败明确提示", () => {
  const settings = { ...model.defaultMonitorSettings, windowHours: 17 };
  const html = renderToStaticMarkup(createElement(MonitorReadControls, { settings, open: true, onOpenChange() {}, onChange() {}, t }));
  assert.ok(html.includes(t("monitorRecentHours", { count: 17 })));
  assert.equal((html.match(/type="number"/g) ?? []).length, 6);
  assert.ok(html.includes(t("monitorApplySettings")));
  assert.ok(render({ saveError: true }).includes(t("monitorSaveFailed")));
});

test("会话展示任务名称、项目和时间，私密模式连同悬停提示一起隐藏", () => {
  const normal = render();
  assert.ok(normal.includes(t("monitorRelated")));
  for (const session of demo.sessions) {
    assert.ok(normal.includes(session.title));
    assert.ok(normal.includes(session.project));
  }
  const visibleText = normal.replace(/<[^>]*>/g, "");
  assert.ok(!visibleText.includes(demo.sessions[0].id.slice(0, 6)));
  assert.ok(visibleText.includes(t("monitorTurnName", { id: 1 })));
  assert.ok(!visibleText.includes("demo-turn-"));
  const privateHtml = render({ privateMode: true });
  for (const session of demo.sessions) {
    assert.ok(!privateHtml.includes(session.title));
    assert.ok(!privateHtml.includes(session.project));
  }
  assert.ok(privateHtml.includes(t("monitorSessionName", { id: 1 })));
  assert.ok(privateHtml.includes(t("monitorDemo")));
  assert.ok(!privateHtml.includes(t("monitorPause")));
});

test("没有名称时用项目和时间兜底，缺少项目也不会退回 Hash", () => {
  const snapshot = { ...demo, sessions: demo.sessions.map((session, index) => ({
    ...session, title: null, project: index === 0 ? session.project : null,
  })) };
  const html = render({ snapshot });
  assert.ok(html.includes(demo.sessions[0].project));
  assert.ok(html.includes(t("monitorLocalSession")));
  const date = new Date(demo.sessions[0].startedAtMs).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  assert.ok(html.includes(date));
  assert.ok(!html.replace(/<[^>]*>/g, "").includes(demo.sessions[0].id.slice(0, 6)));
});

test("轮次按会话内首次开始时间排序，倒序返回与其他会话不影响编号", () => {
  const base = demo.calls[0];
  const calls = [
    { ...base, turnId: "later", startedAtMs: 500, observedAtMs: 600 },
    { ...base, turnId: "earlier", startedAtMs: 100, observedAtMs: 700 },
    { ...base, turnId: "later", startedAtMs: 550, observedAtMs: 650 },
    { ...base, turnId: "foreign", sessionId: "other", startedAtMs: 1 },
    { ...base, turnId: null, startedAtMs: 50 },
  ];
  assert.deepEqual(model.sessionTurns(calls, base.sessionId), ["earlier", "later", "unknown"]);
  assert.deepEqual(model.sessionTurns([...calls].reverse(), base.sessionId), ["earlier", "later", "unknown"]);
});
