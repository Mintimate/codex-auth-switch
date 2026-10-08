import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  expectedUpdaterAssetNames,
  generateUpdaterManifest,
} from "../../.github/scripts/generate-updater-manifest.mjs";

const pullScript = fileURLToPath(
  new URL("./pull-github-release.sh", import.meta.url),
);
const releaseNotesScript = fileURLToPath(
  new URL("../../.github/scripts/generate-release-notes.sh", import.meta.url),
);

function writeMock(directory, name, source) {
  writeFileSync(join(directory, name), `#!/usr/bin/env node\n${source}`, {
    mode: 0o755,
  });
}

test("CNB 镜像等待发布并下载完整附件，更新 URL 与签名对应实际附件", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "codex-cnb-release-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "github-assets");
  const destination = join(directory, "cnb-assets");
  const bin = join(directory, "bin");
  const notesDirectory = join(directory, "docs", "release-notes");
  const scriptDirectory = join(directory, ".github", "scripts");
  for (const path of [
    source,
    destination,
    bin,
    notesDirectory,
    scriptDirectory,
  ]) {
    mkdirSync(path, { recursive: true });
  }

  const version = "1.3.9";
  const tag = `v${version}`;
  const githubRepository = "example/codex-auth-switch";
  const cnbRepository = "example/tool-forge/codex-auth-switch";
  const notes = "# 离线镜像测试\n\n保留发布说明与所有平台签名。";
  const names = [
    ...expectedUpdaterAssetNames(version),
    `Codex-Auth-Switch_${version}_macOS_arm64.dmg`,
    `Codex-Auth-Switch_${version}_macOS_x64.dmg`,
    "latest.json",
  ];
  const release = {
    tag_name: tag,
    body: notes,
    assets: names.map((name, index) => ({
      name,
      url: `https://api.github.com/repos/${githubRepository}/releases/assets/${index + 1}`,
    })),
  };
  for (const name of names.filter((name) => name !== "latest.json")) {
    writeFileSync(join(source, name), `fixture:${name}\n`);
  }
  const manifest = generateUpdaterManifest({
    version,
    tag,
    release,
    signatureDirectory: source,
    pubDate: "2026-09-29T09:00:00.000Z",
  });
  writeFileSync(join(source, "latest.json"), JSON.stringify(manifest));
  writeFileSync(join(destination, "old-release.download"), "stale download");
  writeFileSync(join(notesDirectory, `${tag}.md`), `${notes}\n`);
  copyFileSync(
    releaseNotesScript,
    join(scriptDirectory, "generate-release-notes.sh"),
  );

  writeMock(
    bin,
    "curl",
    String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const url = args.at(-1);
const prefix = "https://github.com/" + process.env.GITHUB_REPOSITORY_SLUG
  + "/releases/download/" + process.env.RELEASE_TAG.replace(/^refs\/tags\//, "") + "/";
if (!url.startsWith(prefix)) throw new Error("Unexpected mock URL: " + url);
const name = decodeURIComponent(url.slice(prefix.length));
const output = args[args.indexOf("--output") + 1];
const state = path.join(process.env.MOCK_DIRECTORY, "manifest-requested");
const unavailable = name === "latest.json" && !fs.existsSync(state);
if (name === "latest.json") fs.writeFileSync(state, "requested");
const source = path.join(process.env.MOCK_DIRECTORY, "github-assets", name);
const status = !unavailable && fs.existsSync(source) ? 200 : 404;
fs.appendFileSync(path.join(process.env.MOCK_DIRECTORY, "curl.jsonl"),
  JSON.stringify({ name, status }) + "\n");
if (status === 200) fs.copyFileSync(source, output);
else fs.writeFileSync(output, "not found");
if (args.includes("--write-out")) process.stdout.write(String(status));
if (status !== 200 && args.includes("--fail")) process.exitCode = 22;
`,
  );
  writeMock(
    bin,
    "git",
    String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.MOCK_DIRECTORY, "git.jsonl"),
  JSON.stringify(args) + "\n");
if (args[0] === "describe") process.stdout.write("v1.3.8\n");
else if (args[0] !== "fetch") throw new Error("Unexpected mock git invocation");
`,
  );
  writeMock(
    bin,
    "sleep",
    String.raw`
require("node:fs").appendFileSync(
  require("node:path").join(process.env.MOCK_DIRECTORY, "sleep.log"),
  process.argv.slice(2).join(" ") + "\n",
);
`,
  );

  const metadataFile = join(directory, "metadata", "release.json");
  const result = spawnSync("bash", [pullScript], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MOCK_DIRECTORY: directory,
      GITHUB_REPOSITORY_SLUG: githubRepository,
      TARGET_CNB_REPO: cnbRepository,
      RELEASE_TAG: `refs/tags/${tag}`,
      RELEASE_ASSETS_DIR: destination,
      GITHUB_RELEASE_METADATA_FILE: metadataFile,
      GITHUB_RELEASE_WAIT_SECONDS: "10",
      GITHUB_RELEASE_POLL_SECONDS: "1",
    },
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /ready with 17 assets/);
  assert.deepEqual(readdirSync(destination).sort(), [...names].sort());

  const requests = readFileSync(join(directory, "curl.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(requests.slice(0, 2), [
    { name: "latest.json", status: 404 },
    { name: "latest.json", status: 200 },
  ]);
  assert.deepEqual(
    requests
      .filter(({ status }) => status === 200)
      .map(({ name }) => name)
      .sort(),
    [...names].sort(),
  );
  assert.equal(readFileSync(join(directory, "sleep.log"), "utf8"), "1\n");

  const mirrored = JSON.parse(readFileSync(join(destination, "latest.json")));
  assert.equal(mirrored.version, manifest.version);
  assert.equal(mirrored.notes, manifest.notes);
  assert.equal(mirrored.pub_date, manifest.pub_date);
  assert.deepEqual(
    Object.keys(mirrored.platforms),
    Object.keys(manifest.platforms),
  );
  for (const [platform, entry] of Object.entries(mirrored.platforms)) {
    const prefix = `https://cnb.cool/${cnbRepository}/-/releases/download/${tag}/`;
    assert.ok(entry.url.startsWith(prefix));
    const name = decodeURIComponent(entry.url.slice(prefix.length));
    assert.ok(names.includes(name), `${platform} 引用了未下载的附件：${name}`);
    assert.equal(entry.signature, manifest.platforms[platform].signature);
    assert.equal(
      readFileSync(join(destination, `${name}.sig`), "utf8"),
      entry.signature,
    );
    assert.equal(
      readFileSync(join(destination, name), "utf8"),
      readFileSync(join(source, name), "utf8"),
    );
  }
  assert.deepEqual(JSON.parse(readFileSync(metadataFile)), {
    tag_name: tag,
    name: tag,
    body: notes,
    draft: false,
    prerelease: false,
  });
  const gitCalls = readFileSync(join(directory, "git.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(gitCalls, [
    [
      "fetch",
      "--force",
      "--tags",
      `https://github.com/${githubRepository}.git`,
      "+refs/tags/*:refs/tags/*",
    ],
    ["describe", "--tags", "--abbrev=0", `${tag}^`],
  ]);
});
