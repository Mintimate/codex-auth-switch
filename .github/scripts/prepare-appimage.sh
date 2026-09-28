#!/usr/bin/env bash
set -euo pipefail

# 与锁定的 Tauri CLI 2.11.4 的 tools_path / apprun-old URL 保持一致。
# 上游 write_and_make_executable 使用 0770，复制到包内后普通用户无法执行。
# 预置 0755 缓存，让修复发生在打包和签名之前，兼容已有的 0770 缓存。
# 升级 Tauri 后需复核此兼容层；最终包仍由 check-appimage.sh 独立验证。
tools_dir="${XDG_CACHE_HOME:-${HOME}/.cache}/tauri"
apprun="${tools_dir}/AppRun-x86_64"
mkdir -p "${tools_dir}"
if [[ ! -s "${apprun}" ]]; then
  download="$(mktemp "${tools_dir}/AppRun-download.XXXXXX")"
  trap 'rm -f -- "${download}"' EXIT
  curl --fail --location --retry 3 \
    'https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64' \
    --output "${download}"
  chmod 755 "${download}"
  mv -- "${download}" "${apprun}"
fi
chmod 755 "${apprun}"
