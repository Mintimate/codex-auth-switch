import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkAppImagePermissions } from "./check-appimage-permissions.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "codex-appimage-permissions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [root, join(root, "usr"), join(root, "usr/bin")]) {
    mkdirSync(path, { recursive: true });
    chmodSync(path, 0o755);
  }
  for (const path of [
    "AppRun",
    "AppRun.wrapped",
    "usr/bin/codex-auth-switch",
  ]) {
    writeFileSync(join(root, path), "fixture\n");
    chmodSync(join(root, path), 0o755);
  }
  return root;
}

test("接受所有用户均可执行的启动文件", (t) => {
  checkAppImagePermissions(fixture(t));
});

test("拒绝 1.3.8 的 AppRun.wrapped 0770 权限，即使当前用户是属主", (t) => {
  const root = fixture(t);
  chmodSync(join(root, "AppRun.wrapped"), 0o770);
  assert.throws(() => checkAppImagePermissions(root), /AppRun\.wrapped.*770/);
});

test("拒绝不可遍历的目录和缺失的启动文件", (t) => {
  const root = fixture(t);
  chmodSync(join(root, "usr/bin"), 0o750);
  assert.throws(() => checkAppImagePermissions(root), /usr\/bin.*750/);
  chmodSync(join(root, "usr/bin"), 0o755);
  rmSync(join(root, "AppRun.wrapped"));
  assert.throws(() => checkAppImagePermissions(root), /ENOENT/);
});

test("允许包内链接但拒绝启动文件指向包外", (t) => {
  const root = fixture(t);
  rmSync(join(root, "AppRun.wrapped"));
  symlinkSync("usr/bin/codex-auth-switch", join(root, "AppRun.wrapped"));
  checkAppImagePermissions(root);
  rmSync(join(root, "AppRun.wrapped"));
  symlinkSync(process.execPath, join(root, "AppRun.wrapped"));
  assert.throws(() => checkAppImagePermissions(root), /启动文件无效/);
});

test("修复既有的 0770 Tauri 缓存且重复执行保持 0755", (t) => {
  const root = fixture(t);
  const tools = join(root, "tauri");
  mkdirSync(tools);
  const apprun = join(tools, "AppRun-x86_64");
  writeFileSync(apprun, "cached AppRun\n", { mode: 0o770 });
  const script = new URL("./prepare-appimage.sh", import.meta.url);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync("bash", [fileURLToPath(script)], {
      env: { ...process.env, XDG_CACHE_HOME: root },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(apprun).mode & 0o7777, 0o755);
  }
});

for (const scenario of ["visible", "missing", "disappeared"]) {
  test(`启动检查正确处理窗口状态：${scenario}`, (t) => {
    const root = fixture(t);
    const bin = join(root, "usr/bin");
    const app = join(root, "application.AppImage");
    writeFileSync(app, "#!/bin/bash\nexec /bin/sleep 60\n", { mode: 0o755 });
    // 用受控进程和窗口探测验证成功/失败分支；不模拟真正的 Linux 图形栈。
    writeFileSync(join(bin, "sleep"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      join(bin, "xdotool"),
      '#!/bin/bash\ncase "$SMOKE_SCENARIO" in\nvisible) exit 0 ;;\nmissing) exit 1 ;;\ndisappeared) if [[ -f "$SMOKE_MARKER" ]]; then exit 1; fi; touch "$SMOKE_MARKER" ;;\nesac\n',
      { mode: 0o755 },
    );
    const script = fileURLToPath(
      new URL("./smoke-appimage.sh", import.meta.url),
    );
    const result = spawnSync("bash", [script, app], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SMOKE_SCENARIO: scenario,
        SMOKE_MARKER: join(root, "window-seen"),
      },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, scenario === "visible" ? 0 : 1, result.stderr);
  });
}
