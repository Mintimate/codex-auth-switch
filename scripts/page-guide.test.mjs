import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

let ipcCalls = 0;
const previousWindow = globalThis.window;
globalThis.window = {
  localStorage: memoryStorage(),
  __TAURI_INTERNALS__: {
    invoke() {
      ipcCalls += 1;
      throw new Error("Regression tests must never access desktop IPC");
    },
  },
  setTimeout,
  setInterval() {
    throw new Error("Regression tests must not start background polling");
  },
};

// 使用演示模式的虚构数据，既不启动监听端口，也不读取真实登录或会话。
const server = await createServer({
  mode: "demo",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
after(async () => {
  await server.close();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});
beforeEach(() => {
  window.localStorage = memoryStorage();
});

const [api, guideState, usageModule, accountsModule, quotaModule, locale] =
  await Promise.all([
    server.ssrLoadModule("/src/api.ts"),
    server.ssrLoadModule("/src/guideState.ts"),
    server.ssrLoadModule("/src/UsagePanel.tsx"),
    server.ssrLoadModule("/src/AccountsPage.tsx"),
    server.ssrLoadModule("/src/QuotaPanel.tsx"),
    server.ssrLoadModule("/src/locales/zh-CN.json"),
  ]);
const { guideStorageKey, readGuideOutcome, saveGuideOutcome } = guideState;
const messages = locale.default;
const t = (key, values = {}) => {
  assert.equal(typeof messages[key], "string", `Missing translation: ${key}`);
  return Object.entries(values).reduce(
    (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
    messages[key],
  );
};
const [status, usage, quotas, modelProvider] = await Promise.all([
  api.getStatus(),
  api.getLocalUsage(),
  api.getAccountQuotas(),
  api.getModelProviderState(),
]);
const noAction = () => assert.fail("Rendering must not perform user actions");
const shared = { locale: "zh-CN", privateMode: false, t, onRefresh: noAction };
const renderUsage = (overrides = {}) =>
  renderToStaticMarkup(
    createElement(usageModule.UsagePanel, {
      ...shared,
      usage: null,
      loading: false,
      error: null,
      modelProvider,
      ...overrides,
    }),
  );
const renderAccounts = (overrides = {}) =>
  renderToStaticMarkup(
    createElement(accountsModule.AccountsPage, {
      ...shared,
      hostedLoginEnabled: false,
      busy: false,
      loading: false,
      quotas,
      quotaRefreshingIds: [],
      quotaRefreshErrors: {},
      onRefreshQuota: noAction,
      switchingId: null,
      onImport: noAction,
      onOpenConfig: noAction,
      onLogin: noAction,
      onRemove: noAction,
      onRename: noAction,
      onSave: noAction,
      onShare: noAction,
      onSwitch: noAction,
      autoRestart: false,
      status,
      ...overrides,
    }),
  );
const renderQuota = (overrides = {}) =>
  renderToStaticMarkup(
    createElement(quotaModule.QuotaPanel, {
      ...shared,
      accounts: status.accounts,
      activeAccountId: status.activeAccountId,
      refreshingIds: [],
      refreshErrors: {},
      onRefreshAccount: noAction,
      onOpenAccounts: noAction,
      onOpenConfig: noAction,
      error: null,
      loading: false,
      quotas,
      supported: true,
      ...overrides,
    }),
  );
const textOf = (html) => html.replace(/<[^>]*>/g, "").trim();
const buttonLabels = (html) =>
  [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
    textOf(match[1]),
  );
const assertButton = (html, key) =>
  assert.ok(buttonLabels(html).includes(t(key)), `Missing button: ${t(key)}`);
const accountEmptyState = (html) => {
  const start = html.lastIndexOf('class="empty-state"');
  assert.ok(start >= 0, "Expected an account empty state");
  return html.slice(start);
};
const zeroTokens = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};
const noEvents = {
  ...usage,
  today: zeroTokens,
  sevenDays: zeroTokens,
  thirtyDays: zeroTokens,
  daily: [],
  byProvider: [],
  byAccount: [],
  unassigned: zeroTokens,
  eventsCount: 0,
  filesScanned: 0,
};

test("跳过与完成能持久化，并在新的模块会话中恢复", async () => {
  const skipped = guideStorageKey("persist-skip", "overview");
  const completed = guideStorageKey("persist-complete", "overview");
  saveGuideOutcome(skipped, "skipped");
  saveGuideOutcome(completed, "completed");
  assert.equal(window.localStorage.getItem(skipped), "skipped");
  assert.equal(window.localStorage.getItem(completed), "completed");
  const fresh = await server.ssrLoadModule(
    "/src/guideState.ts?persist-roundtrip",
  );
  assert.notEqual(fresh.readGuideOutcome, readGuideOutcome);
  assert.equal(fresh.readGuideOutcome(skipped), "skipped");
  assert.equal(fresh.readGuideOutcome(completed), "completed");
});

test("一个页面的空态引导不会标记其数据态或其他页面", () => {
  const empty = guideStorageKey("isolation-accounts", "empty");
  const populated = guideStorageKey("isolation-accounts", "overview");
  const otherPage = guideStorageKey("isolation-quota", "empty");
  saveGuideOutcome(empty, "skipped");
  assert.equal(readGuideOutcome(empty), "skipped");
  assert.equal(readGuideOutcome(populated), null);
  assert.equal(readGuideOutcome(otherPage), null);
  saveGuideOutcome(populated, "completed");
  assert.equal(readGuideOutcome(empty), "skipped");
  assert.equal(readGuideOutcome(populated), "completed");
  assert.equal(readGuideOutcome(otherPage), null);
});

test("存储读写均抛错时仍记住本次会话的选择", () => {
  window.localStorage = {
    getItem() {
      throw new Error("Storage access denied");
    },
    setItem() {
      throw new Error("Storage access denied");
    },
  };
  const key = guideStorageKey("storage-denied", "overview");
  assert.equal(readGuideOutcome(key), null);
  assert.doesNotThrow(() => saveGuideOutcome(key, "skipped"));
  assert.equal(readGuideOutcome(key), "skipped");
  assert.doesNotThrow(() => saveGuideOutcome(key, "completed"));
  assert.equal(readGuideOutcome(key), "completed");
});

test("存储可读但写入失败时，本次完成不会退回磁盘里的旧跳过状态", () => {
  const key = guideStorageKey("storage-full", "overview");
  window.localStorage.setItem(key, "skipped");
  window.localStorage.setItem = () => {
    throw new Error("Storage quota exceeded");
  };
  saveGuideOutcome(key, "completed");
  assert.equal(readGuideOutcome(key), "completed");
});

test("忽略未知或损坏的持久化状态", () => {
  for (const [index, value] of [
    "",
    "true",
    "1",
    '"completed"',
    '{"state":"skipped"}',
    "unknown",
  ].entries()) {
    const key = guideStorageKey("invalid-state", String(index));
    window.localStorage.setItem(key, value);
    assert.equal(readGuideOutcome(key), null);
  }
});

test("Token 页区分尚未读取与正在加载，并保留明确的读取入口", () => {
  const unread = renderUsage();
  assert.ok(unread.includes(t("usageNotLoaded")));
  assertButton(unread, "loadUsage");
  assert.ok(!unread.includes("自动刷新已关闭"));
  assert.doesNotMatch(unread, /class="usage-metrics"/);
  const loading = renderUsage({ loading: true });
  assert.match(loading, /class="usage-skeleton"/);
  assert.ok(loading.includes(t("usageLoading")));
  assert.ok(!loading.includes(t("usageNoEvents")));
  assert.doesNotMatch(loading, /class="page-guide-invitation"/);
});

test("成功读取但没有事件时显示下一步，不把整页零值图表当作入门说明", () => {
  const html = renderUsage({ usage: noEvents });
  assert.ok(html.includes(t("usageNoEvents")));
  assert.ok(html.includes(t("usageNoEventsHint")));
  assertButton(html, "refreshUsage");
  assert.doesNotMatch(html, /class="usage-metrics"|class="trend-bars"/);
  assert.match(html, /class="page-guide-invitation"/);
  // 有事件但数字为零仍是成功读取的数据，不能冒充没有日志。
  const recordedZero = renderUsage({ usage: { ...noEvents, eventsCount: 1 } });
  assert.match(recordedZero, /class="usage-metrics"/);
  assert.ok(!recordedZero.includes(t("usageNoEvents")));
});

test("读取失败不会变成无记录或零统计，并提供重试而非首次邀请", () => {
  for (const oldUsage of [null, noEvents]) {
    const html = renderUsage({ usage: oldUsage, error: "虚构的本机读取错误" });
    assert.ok(html.includes(t("usageReadFailed")));
    assert.ok(html.includes("虚构的本机读取错误"));
    assertButton(html, "retry");
    assertButton(html, "guideOpen");
    assert.ok(!html.includes(t("usageNoEvents")));
    assert.ok(!html.includes(t("usageNotLoaded")));
    assert.doesNotMatch(
      html,
      /class="usage-metrics"|class="page-guide-invitation"/,
    );
  }
});

test("刷新失败保留上次成功的 Token 数据，并明确标记未更新", () => {
  const html = renderUsage({ usage, error: "虚构的刷新失败" });
  assert.ok(html.includes(t("usageCachedDataHint")));
  assert.match(html, /class="usage-metrics"/);
  assert.ok(
    html.includes(
      new Intl.NumberFormat("zh-CN").format(usage.today.totalTokens),
    ),
  );
  assertButton(html, "retry");
  assert.ok(!html.includes(t("usageNoEvents")));
  assert.doesNotMatch(html, /class="page-guide-invitation"/);
});

test("账号空态按检测到的登录分流到保存或登录", () => {
  const savedLogin = renderAccounts({ status: { ...status, accounts: [] } });
  const saveEmpty = accountEmptyState(savedLogin);
  assert.ok(saveEmpty.includes(t("accountsEmptySaveHint")));
  assertButton(saveEmpty, "saveCurrentLogin");
  const loggedOut = renderAccounts({
    status: { ...status, activeAccountId: null, accounts: [] },
  });
  const loginEmpty = accountEmptyState(loggedOut);
  assert.ok(loginEmpty.includes(t("accountsEmptyLoginHint")));
  assertButton(loginEmpty, "loginNewAccount");
  assert.ok(!loginEmpty.includes(t("accountsEmptySaveHint")));
});

test("账号状态不可读显示恢复入口，不把未知状态当成尚未添加账号", () => {
  const html = renderAccounts({ status: null, quotas: null });
  const empty = accountEmptyState(html);
  assert.ok(empty.includes(t("accountsStatusUnavailable")));
  assertButton(empty, "refresh");
  assert.ok(!empty.includes(t("noSavedAccounts")));
  assert.doesNotMatch(html, /class="account-card(?:\s|")/);
});

test("账号存储模式不支持时，空账号和已有账号都能前往配置", () => {
  for (const accounts of [[], status.accounts]) {
    const html = renderAccounts({
      status: { ...status, supported: false, storageMode: "keyring", accounts },
    });
    assert.match(html, /data-guide="accounts-setup"/);
    assert.ok(html.includes(t("accountsGuideStorageDescription")));
    assertButton(html, "accountsOpenConfig");
  }
});

test("账号额度刷新失败时保留已知的剩余值，并标注缓存结果", () => {
  const html = renderAccounts({
    quotaRefreshErrors: { [status.accounts[0].id]: "虚构的额度错误" },
  });
  assert.ok(html.includes(t("accountQuotaRemaining")));
  assert.ok(html.includes(t("quotaCachedResult")));
  assert.match(html, /<strong>62%<\/strong>/);
  assert.match(html, /<strong>36%<\/strong>/);
});

test("订阅额度无账号与存储不支持时分别提供账号、配置 CTA", () => {
  const empty = renderQuota({ accounts: [], quotas: [] });
  assertButton(empty, "quotaGuideOpenAccounts");
  assert.ok(empty.includes(t("quotaGuideEmptyDescription")));
  assert.doesNotMatch(empty, /class="quota-overview-stat/);
  const unsupported = renderQuota({ supported: false });
  assertButton(unsupported, "codexConfigPageTitle");
  assert.ok(unsupported.includes(t("quotaStorageUnsupported")));
  assert.doesNotMatch(unsupported, /class="quota-overview-stat/);
});

test("订阅额度查询失败显示未知值与刷新入口，不显示已用 0% 或 Token 零值", () => {
  const failedQuotas = quotas.map((quota) => ({
    ...quota,
    success: false,
    error: "虚构的查询失败",
    primary: null,
    secondary: null,
    buckets: [],
    officialUsage: null,
    resetCredits: null,
  }));
  const html = renderQuota({
    quotas: failedQuotas,
    error: "虚构的查询失败",
    refreshErrors: Object.fromEntries(
      status.accounts.map((account) => [account.id, "虚构的查询失败"]),
    ),
  });
  assert.match(html, /data-guide="quota-retry-status"/);
  assert.ok(html.includes("虚构的查询失败"));
  assert.doesNotMatch(
    html,
    /data-guide="quota-unavailable"|class="page-guide-invitation"/,
  );
  assertButton(html, "refreshQuota");
  assertButton(html, "retry");
  assert.doesNotMatch(html, /aria-valuenow="|<strong[^>]*>0%<\/strong>/);
  const unknownStats = [
    ...html.matchAll(
      /<div class="quota-overview-stat (?:usage|credits)">([\s\S]*?)<\/div>/g,
    ),
  ];
  assert.equal(unknownStats.length, 3);
  for (const stat of unknownStats) {
    assert.match(stat[1], /<strong>—<\/strong>/);
  }
});

test("订阅额度刷新失败保留已知的已用值，且与账号页的剩余方向一致", () => {
  const html = renderQuota({
    error: "虚构的刷新失败",
    refreshErrors: { [status.accounts[0].id]: "虚构的刷新失败" },
  });
  assert.ok(html.includes(t("quotaCachedResult")));
  assert.ok(html.includes(t("quotaHighestUsage")));
  assert.match(html, /aria-valuenow="64"/);
  assert.match(html, /data-guide="quota-retry-status"/);
  assertButton(html, "retry");
  assert.doesNotMatch(html, /data-guide="quota-unavailable"/);
});

test("首次额度查询抛错时直接提供重试，不把失败解释成待初始化或零额度", () => {
  const html = renderQuota({ quotas: null, error: "虚构的首次查询错误" });
  assert.match(html, /data-guide="quota-retry-status"/);
  assert.ok(html.includes("虚构的首次查询错误"));
  assertButton(html, "retry");
  assertButton(html, "guideOpen");
  assert.doesNotMatch(
    html,
    /data-guide="quota-unavailable"|class="page-guide-invitation"/,
  );
  assert.doesNotMatch(html, /aria-valuenow="|<strong[^>]*>0%<\/strong>/);
  const unknownStats = [
    ...html.matchAll(
      /<div class="quota-overview-stat (?:usage|credits)">([\s\S]*?)<\/div>/g,
    ),
  ];
  assert.equal(unknownStats.length, 3);
  assert.ok(
    unknownStats.every((stat) => stat[1].includes("<strong>—</strong>")),
  );
});

test("全部账号本次刷新失败时优先重试说明，旧成功快照仍保留但不触发数据解读邀请", () => {
  assert.ok(quotas.every((quota) => quota.success));
  const html = renderQuota({
    error: null,
    quotas,
    refreshErrors: Object.fromEntries(
      status.accounts.map((account) => [account.id, "虚构的本次刷新错误"]),
    ),
  });
  assert.match(html, /data-guide="quota-retry-status"/);
  assert.ok(html.includes(t("quotaGuideRefreshErrorDescription")));
  assertButton(html, "retry");
  assertButton(html, "guideOpen");
  assert.match(html, /aria-valuenow="64"/);
  assert.match(html, /aria-valuenow="17"/);
  assert.ok(html.includes(t("quotaCachedResult")));
  assert.doesNotMatch(
    html,
    /data-guide="quota-unavailable"|class="page-guide-invitation"/,
  );
});

test("只有部分账号刷新失败时保留逐账号提示，不把整个额度页判为失败", () => {
  const html = renderQuota({
    error: null,
    refreshErrors: { [status.accounts[0].id]: "虚构的单账号刷新错误" },
  });
  assert.ok(html.includes(t("quotaCachedResult")));
  assert.match(html, /aria-valuenow="64"/);
  assert.doesNotMatch(html, /data-guide="quota-retry-status"/);
  assert.match(html, /class="page-guide-invitation"/);
});

test("实际页面尊重跳过与完成状态，仍可重看，并为新数据状态保留邀请", () => {
  saveGuideOutcome(guideStorageKey("usage", "loaded"), "completed");
  const completed = renderUsage({ usage });
  assert.doesNotMatch(completed, /class="page-guide-invitation"/);
  assertButton(completed, "guideOpen");
  assert.match(
    renderUsage({ usage: noEvents }),
    /class="page-guide-invitation"/,
  );
  saveGuideOutcome(guideStorageKey("quota", "data"), "skipped");
  const skipped = renderQuota();
  assert.doesNotMatch(skipped, /class="page-guide-invitation"/);
  assertButton(skipped, "guideOpen");
  assert.match(
    renderQuota({ accounts: [], quotas: [] }),
    /class="page-guide-invitation"/,
  );
});

test("回归数据来自虚构演示，全部读取和渲染都未调用真实 IPC", () => {
  assert.ok(
    status.accounts.every((account) => account.email.endsWith("@example.com")),
  );
  assert.equal(ipcCalls, 0);
});
