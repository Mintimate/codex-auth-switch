import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

// 即使页面意外出现 Tauri 标记，公开演示也不能调用 IPC。
let ipcCalls = 0;
globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke() {
      ipcCalls += 1;
      throw new Error("Unexpected IPC call");
    },
  },
  setTimeout,
  setInterval() {
    throw new Error("The public demo must not start background polling");
  },
};
const server = await createServer({
  mode: "demo",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
});
after(async () => {
  await server.close();
  delete globalThis.window;
});
const api = await server.ssrLoadModule("/src/api.ts");
const quota = await server.ssrLoadModule("/src/quotaRefreshApi.ts");

test("演示版读取虚构数据，返回值不会污染后续读取", async () => {
  const status = await api.getStatus();
  assert.equal(status.accounts.length, 2);
  assert.ok(
    status.accounts.every((account) => account.email.endsWith("@example.com")),
  );
  status.accounts.length = 0;
  assert.equal((await api.getStatus()).accounts.length, 2);
  assert.equal(await api.getHostedLogin(), null);
  assert.equal(await api.desktopRestartSupported(), false);
  for (const read of [
    api.getLocalUsage,
    api.getModelPrices,
    api.getModelProviderState,
    api.getAccountQuotas,
    api.getQuotaHistory,
    api.getLocalDiagnostics,
    api.getNetworkProxy,
    api.getCodexManagedConfig,
    api.getUsageCacheInfo,
    api.getAppVersion,
  ])
    assert.ok(await read());
  assert.equal(ipcCalls, 0);
});

test("登录、凭据、账号、配置与更新操作都在 API 边界拒绝", async () => {
  const before = await api.getStatus();
  const profileId = before.accounts[0].id;
  for (const action of [
    () => api.saveCurrent("demo"),
    () => api.startHostedLogin("demo"),
    () => api.cancelHostedLogin("demo"),
    () => api.openHostedLogin("demo"),
    () => api.copyHostedLogin("demo"),
    () => api.startDeviceLogin("demo"),
    () => api.pollDeviceLogin("demo"),
    () => api.cancelDeviceLogin("demo"),
    () => api.switchAccount(profileId),
    () =>
      api.switchAccountWithOptions(profileId, true, () =>
        assert.fail("Unexpected switch progress"),
      ),
    () => api.verifyAccountSwitch(profileId),
    () => api.renameAccount(profileId, "renamed"),
    () => api.removeAccount(profileId),
    () => api.prepareAuthTransfer(profileId),
    () => api.copyAuthTransfer(profileId),
    () => api.importAuthFromClipboard(),
    () => api.importAuthFromQr("demo"),
    () => api.setCodexContextMode("oneMillion"),
    () => api.setCodexConfigChoice("credentialStorage", "keyring"),
    () => api.enableFileCredentialStorage(),
    () => api.setNetworkProxy({ mode: "off", proxyUrl: "", noProxy: "" }),
    () => api.clearUsageCache(),
    () => api.clearQuotaHistory(),
    () => api.checkAppUpdate("github"),
    () => api.installAppUpdate(),
    () => quota.setBackgroundQuotaRefresh(true),
  ])
    await assert.rejects(action, /在线预览仅支持浏览/);
  assert.deepEqual(await api.getStatus(), before);
  assert.equal(ipcCalls, 0);
});

test("初次进入即显示额度样例，忽略旧的后台刷新偏好且仍可手动刷新", async () => {
  const initial = await quota.initializeQuotaRefresh(true);
  assert.equal(initial.enabled, false);
  assert.equal(initial.quotas.length, 2);
  let updates = 0;
  const unsubscribe = await quota.subscribeQuotaRefresh(() => {
    updates += 1;
  });
  const refreshed = await quota.refreshQuotas();
  unsubscribe();
  assert.equal(refreshed.quotas.length, 2);
  assert.deepEqual(refreshed.refreshingIds, []);
  assert.ok(updates > 0);
  assert.equal(ipcCalls, 0);
});
