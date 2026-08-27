#!/usr/bin/env node

// 同步版本号：package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json
// 并刷新 package-lock.json 与 src-tauri/Cargo.lock 中本项目自身的版本号。
//
// 用法：
//   npm run bump 0.7.3          仅改文件
//   npm run release 0.7.3       改文件 + git commit + git tag
//
// CI（.github/workflows/build-installers.yml）以 tauri.conf.json 的 version 为准，
// 并校验 git 标签与之一致，因此三处版本号必须完全相同。

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CRATE_NAME = "codex-auth-switch";

const paths = {
  packageJson: join(repoRoot, "package.json"),
  packageLock: join(repoRoot, "package-lock.json"),
  cargoToml: join(repoRoot, "src-tauri/Cargo.toml"),
  cargoLock: join(repoRoot, "src-tauri/Cargo.lock"),
  tauriConf: join(repoRoot, "src-tauri/tauri.conf.json"),
};

const fail = (message) => {
  console.error(`错误：${message}`);
  process.exit(1);
};

const read = (path) => readFileSync(path, "utf8");

// 保留文件末尾换行习惯，避免产生无意义 diff。
const writeText = (path, text) => writeFileSync(path, text, "utf8");

const writeJson = (path, value, original) => {
  const trailing = original.endsWith("\n") ? "\n" : "";
  writeText(path, `${JSON.stringify(value, null, 2)}${trailing}`);
};

const parseArgs = (argv) => {
  const args = argv.slice(2);
  const flags = new Set(args.filter((arg) => arg.startsWith("-")));
  const positional = args.filter((arg) => !arg.startsWith("-"));

  if (positional.length !== 1) {
    fail("用法：npm run bump <version>，例如 npm run bump 0.7.3");
  }

  return {
    version: positional[0].replace(/^v/, ""),
    commit: flags.has("--commit") || flags.has("--release"),
    tag: flags.has("--tag") || flags.has("--release"),
    allowDirty: flags.has("--allow-dirty"),
  };
};

// 语义化版本，允许 1.2.3 与 1.2.3-beta.1 形式（CI 用连字符判定预发布）。
const assertSemver = (version) => {
  const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  if (!semver.test(version)) {
    fail(`版本号 ${version} 不是合法的语义化版本，期望形如 0.7.3 或 0.7.3-beta.1`);
  }
};

const git = (...args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

const assertCleanTree = (allowDirty) => {
  const status = git("status", "--porcelain");
  if (status && !allowDirty) {
    fail(
      "工作区存在未提交变更，请先提交或使用 --allow-dirty 跳过检查：\n" + status,
    );
  }
};

const assertTagAbsent = (tag) => {
  const existing = git("tag", "--list", tag);
  if (existing === tag) {
    fail(`标签 ${tag} 已存在，请改用新的版本号`);
  }
};

// package.json：根 version 字段。
const bumpPackageJson = (version) => {
  const original = read(paths.packageJson);
  const data = JSON.parse(original);
  const from = data.version;
  data.version = version;
  writeJson(paths.packageJson, data, original);
  return from;
};

// package-lock.json：根 version 与 packages[""].version 两处。
const bumpPackageLock = (version) => {
  if (!existsSync(paths.packageLock)) return null;
  const original = read(paths.packageLock);
  const data = JSON.parse(original);
  const from = data.version;
  data.version = version;
  if (data.packages?.[""]) {
    data.packages[""].version = version;
  }
  writeJson(paths.packageLock, data, original);
  return from;
};

// tauri.conf.json：顶层 version，CI 的版本来源。
const bumpTauriConf = (version) => {
  const original = read(paths.tauriConf);
  const data = JSON.parse(original);
  const from = data.version;
  data.version = version;
  writeJson(paths.tauriConf, data, original);
  return from;
};

// Cargo.toml：只改 [package] 段内第一个 version，不碰依赖版本。
const bumpCargoToml = (version) => {
  const original = read(paths.cargoToml);
  let from = null;
  let inPackage = false;
  let done = false;

  const lines = original.split("\n").map((line) => {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inPackage = section[1] === "package";
      return line;
    }
    if (inPackage && !done) {
      const match = line.match(/^(\s*version\s*=\s*")([^"]+)(".*)$/);
      if (match) {
        from = match[2];
        done = true;
        return `${match[1]}${version}${match[3]}`;
      }
    }
    return line;
  });

  if (!done) fail("未能在 src-tauri/Cargo.toml 的 [package] 段中找到 version");
  writeText(paths.cargoToml, lines.join("\n"));
  return from;
};

// Cargo.lock：只改 name = "codex-auth-switch" 所属的 [[package]] 块。
// 注意 Cargo.lock 中存在同名版本的第三方依赖（例如 async-broadcast 0.7.2），
// 直接全局替换会损坏锁文件，因此必须按包块定位。
const bumpCargoLock = (version) => {
  if (!existsSync(paths.cargoLock)) return null;
  const original = read(paths.cargoLock);
  const lines = original.split("\n");

  let from = null;
  let targetBlock = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.trim() === "[[package]]") {
      targetBlock = false;
      continue;
    }

    const nameMatch = line.match(/^name\s*=\s*"([^"]+)"\s*$/);
    if (nameMatch) {
      targetBlock = nameMatch[1] === CRATE_NAME;
      continue;
    }

    if (targetBlock) {
      const versionMatch = line.match(/^(version\s*=\s*")([^"]+)(".*)$/);
      if (versionMatch) {
        from = versionMatch[2];
        lines[i] = `${versionMatch[1]}${version}${versionMatch[3]}`;
        break;
      }
    }
  }

  if (!from) fail(`未能在 src-tauri/Cargo.lock 中定位 ${CRATE_NAME} 的版本`);
  writeText(paths.cargoLock, lines.join("\n"));
  return from;
};

// 回读三处版本号，确认真的一致，避免 CI 才发现不匹配。
const verify = (version) => {
  const actual = {
    "package.json": JSON.parse(read(paths.packageJson)).version,
    "src-tauri/tauri.conf.json": JSON.parse(read(paths.tauriConf)).version,
    "src-tauri/Cargo.toml": read(paths.cargoToml).match(
      /\[package\][\s\S]*?version\s*=\s*"([^"]+)"/,
    )?.[1],
  };

  const mismatched = Object.entries(actual).filter(([, value]) => value !== version);
  if (mismatched.length > 0) {
    fail(
      "版本号校验失败：\n" +
        mismatched.map(([file, value]) => `  ${file} = ${value}`).join("\n"),
    );
  }
  return actual;
};

const main = () => {
  const { version, commit, tag, allowDirty } = parseArgs(process.argv);
  assertSemver(version);

  const tagName = `v${version}`;
  if (commit || tag) {
    assertCleanTree(allowDirty);
    assertTagAbsent(tagName);
  }

  const previous = bumpPackageJson(version);
  if (previous === version) {
    fail(`当前版本已经是 ${version}，无需修改`);
  }

  bumpPackageLock(version);
  bumpTauriConf(version);
  bumpCargoToml(version);
  bumpCargoLock(version);

  verify(version);

  const changed = [
    "package.json",
    "package-lock.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/tauri.conf.json",
  ].filter((file) => existsSync(join(repoRoot, file)));

  console.log(`版本号已从 ${previous} 更新为 ${version}：`);
  for (const file of changed) console.log(`  ${file}`);

  if (commit) {
    git("add", ...changed);
    git("commit", "-m", `chore(release): 发布 ${version} 版本`);
    console.log(`\n已提交：chore(release): 发布 ${version} 版本`);
  }

  if (tag) {
    git("tag", "-a", tagName, "-m", `Codex Auth Switch ${tagName}`);
    console.log(`已创建标签：${tagName}`);
  }

  if (commit || tag) {
    console.log(`\n推送以触发发布流水线：\n  git push origin main --follow-tags`);
  } else {
    console.log(
      `\n下一步：\n  git add ${changed.join(" ")}\n` +
        `  git commit -m "chore(release): 发布 ${version} 版本"\n` +
        `  git tag -a ${tagName} -m "Codex Auth Switch ${tagName}"\n` +
        `  git push origin main --follow-tags`,
    );
  }
};

main();
