#!/usr/bin/env bash
set -euo pipefail

"${1:?需要指定 AppImage 文件}" &
app_pid=$!
trap 'kill "${app_pid}" 2>/dev/null || true; wait "${app_pid}" 2>/dev/null || true' EXIT

for ((attempt = 0; attempt < 30; attempt++)); do
  if ! kill -0 "${app_pid}" 2>/dev/null; then
    echo "::error::AppImage 在窗口出现前退出"
    exit 1
  fi
  if xdotool search --onlyvisible --name '^Codex Auth Switch$' >/dev/null 2>&1; then
    # 窗口创建后继续观察，避免刚出现就崩溃也被视为成功。
    sleep 10
    kill -0 "${app_pid}"
    xdotool search --onlyvisible --name '^Codex Auth Switch$' >/dev/null
    echo "AppImage 窗口已出现并保持运行"
    exit 0
  fi
  sleep 1
done
echo "::error::AppImage 在 30 秒内没有显示主窗口"
exit 1
