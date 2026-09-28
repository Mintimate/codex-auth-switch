#!/usr/bin/env node
import { realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function checkAppImagePermissions(directory) {
  const root = realpathSync(directory);
  const entries = ["AppRun", "AppRun.wrapped", "usr/bin/codex-auth-switch"];
  for (const entry of entries) {
    const file = realpathSync(resolve(root, entry));
    if (!file.startsWith(`${root}${sep}`) || !statSync(file).isFile()) {
      throw new Error(`AppImage 启动文件无效：${entry}`);
    }
    // 不能只用 access(X_OK)：解包用户可能是属主，0770 也会通过。
    for (let path = file; ; path = dirname(path)) {
      const mode = statSync(path).mode & 0o7777;
      if ((mode & 0o555) !== 0o555 || (mode & 0o7000) !== 0) {
        throw new Error(
          `AppImage 路径必须允许所有用户读取和执行且无特殊权限：${path.slice(root.length) || "/"} (${mode.toString(8)})`,
        );
      }
      if (path === root) break;
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  checkAppImagePermissions(process.argv[2]);
  console.log("AppImage 启动文件及目录权限检查通过");
}
