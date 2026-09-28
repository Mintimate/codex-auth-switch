import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  expectedUpdaterAssetNames,
  generateUpdaterManifest,
} from "./generate-updater-manifest.mjs";

function createFixture(version = "1.2.3") {
  const directory = mkdtempSync(join(tmpdir(), "codex-updater-manifest-"));
  const names = expectedUpdaterAssetNames(version);
  const assets = names.map((name, index) => ({
    id: index + 1,
    name,
    label: name,
    url: `https://api.example.com/releases/assets/${index + 1}`,
  }));

  for (const name of names.filter((name) => name.endsWith(".sig"))) {
    writeFileSync(join(directory, name), `signature:${name}\n`);
  }

  return {
    directory,
    release: {
      tag_name: `v${version}`,
      body: "release notes",
      assets,
    },
  };
}

test("AppImage 使用独立名称及签名，其他 Linux 安装包保留名称", () => {
  const names = expectedUpdaterAssetNames("1.2.3");
  assert.ok(names.includes("Codex-Auth-Switch_1.2.3_x86_64.AppImage"));
  assert.ok(names.includes("Codex-Auth-Switch_1.2.3_x86_64.AppImage.sig"));
  assert.ok(names.includes("Codex-Auth-Switch_1.2.3_Linux_x64.deb"));
  assert.ok(names.includes("Codex-Auth-Switch_1.2.3_Linux_x64.rpm"));
  assert.ok(!names.some((name) => /Linux.*\.AppImage/.test(name)));
});

test("AppImage 更新 URL 和签名对应同一新命名资产", (t) => {
  const { directory, release } = createFixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const asset = release.assets.find(
    (entry) => entry.name === "Codex-Auth-Switch_1.2.3_x86_64.AppImage",
  );
  const manifest = generateUpdaterManifest({
    version: "1.2.3",
    tag: "v1.2.3",
    release,
    signatureDirectory: directory,
  });
  assert.deepEqual(manifest.platforms["linux-x86_64"], {
    url: asset.url,
    signature: "signature:Codex-Auth-Switch_1.2.3_x86_64.AppImage.sig\n",
  });
  assert.deepEqual(
    manifest.platforms["linux-x86_64"],
    manifest.platforms["linux-x86_64-appimage"],
  );
});

test("生成完整的跨平台 updater 清单", (t) => {
  const { directory, release } = createFixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const manifest = generateUpdaterManifest({
    version: "1.2.3",
    tag: "v1.2.3",
    release,
    signatureDirectory: directory,
    pubDate: "2026-09-02T00:00:00.000Z",
  });

  assert.equal(manifest.version, "1.2.3");
  assert.equal(manifest.notes, "release notes");
  assert.equal(Object.keys(manifest.platforms).length, 11);
  assert.deepEqual(
    manifest.platforms["windows-x86_64"],
    manifest.platforms["windows-x86_64-nsis"],
  );
  assert.deepEqual(
    manifest.platforms["linux-x86_64"],
    manifest.platforms["linux-x86_64-appimage"],
  );
  assert.equal(
    manifest.platforms["darwin-aarch64"].url,
    "https://api.example.com/releases/assets/1",
  );
});

test("缺少安装资产时拒绝生成清单", (t) => {
  const { directory, release } = createFixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  release.assets = release.assets.filter(
    (asset) => !asset.name.endsWith("Linux_x64.rpm"),
  );

  assert.throws(
    () =>
      generateUpdaterManifest({
        version: "1.2.3",
        tag: "v1.2.3",
        release,
        signatureDirectory: directory,
      }),
    /Linux_x64\.rpm/,
  );
});

test("版本与标签不一致时拒绝生成清单", (t) => {
  const { directory, release } = createFixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  assert.throws(
    () =>
      generateUpdaterManifest({
        version: "1.2.3",
        tag: "v1.2.4",
        release,
        signatureDirectory: directory,
      }),
    /版本 1\.2\.3 与标签 v1\.2\.4 不一致/,
  );
});
