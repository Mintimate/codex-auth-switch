#!/usr/bin/env bash

set -euo pipefail

release_tag="${1:?用法：generate-release-notes.sh <release-tag> [previous-tag]}"
previous_tag="${2:-}"
release_notes_file="docs/release-notes/${release_tag}.md"

if [[ -f "${release_notes_file}" ]]; then
  cat "${release_notes_file}"
  exit 0
fi

version="${release_tag#v}"
github_repository="${GITHUB_REPOSITORY:-Mintimate/codex-auth-switch}"
github_url="${GITHUB_SERVER_URL:-https://github.com}/${github_repository}"
cnb_url="https://cnb.cool/Mintimate/tool-forge/codex-auth-switch"
release_date="$(TZ=Asia/Shanghai date '+%Y-%m-%d')"

log_range="HEAD"
if [[ -n "${previous_tag}" ]]; then
  log_range="${previous_tag}..HEAD"
fi

commits=()
while IFS= read -r commit; do
  commits+=("${commit}")
done < <(
  git log --format='%H%x09%s' "${log_range}" -- . \
    ':(exclude)package.json' \
    ':(exclude)package-lock.json' \
    ':(exclude)src-tauri/Cargo.toml' \
    ':(exclude)src-tauri/Cargo.lock' \
    ':(exclude)src-tauri/tauri.conf.json'
)

if [[ ${#commits[@]} -eq 0 ]]; then
  while IFS= read -r commit; do
    commits+=("${commit}")
  done < <(git log -1 --format='%H%x09%s')
fi

declare -a features=()
declare -a fixes=()
declare -a improvements=()
declare -a engineering=()
declare -a others=()
declare -a highlights=()
conventional_commit_pattern='^([[:alpha:]]+)(\([^)]*\))?(!)?:[[:space:]]*(.+)$'

for commit in "${commits[@]}"; do
  hash="${commit%%$'\t'*}"
  subject="${commit#*$'\t'}"
  short_hash="${hash:0:7}"
  type=""
  description="${subject}"
  breaking=""

  if [[ "${subject}" =~ ${conventional_commit_pattern} ]]; then
    type="$(printf '%s' "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')"
    description="${BASH_REMATCH[4]}"
    if [[ -n "${BASH_REMATCH[3]}" ]]; then
      breaking="⚠️ "
    fi
  fi

  bullet="- ${breaking}[${description}](${github_url}/commit/${hash}) (\`${short_hash}\`)"
  case "${type}" in
    feat)
      features+=("${bullet}")
      highlights+=("${description}")
      ;;
    fix)
      fixes+=("${bullet}")
      highlights+=("${description}")
      ;;
    perf | refactor | style)
      improvements+=("${bullet}")
      highlights+=("${description}")
      ;;
    docs | ci | build | chore | test)
      engineering+=("${bullet}")
      ;;
    *)
      others+=("${bullet}")
      ;;
  esac
done

if [[ ${#highlights[@]} -eq 0 ]]; then
  for commit in "${commits[@]}"; do
    highlights+=("${commit#*$'\t'}")
    [[ ${#highlights[@]} -ge 3 ]] && break
  done
fi

print_category() {
  local heading="$1"
  shift

  if [[ $# -eq 0 ]]; then
    return
  fi

  printf '### %s\n\n' "${heading}"
  printf '%s\n' "$@"
  printf '\n'
}

cat <<EOF
# Codex Auth Switch ${release_tag}

> 本版本包含 ${#commits[@]} 项变更，继续保持纯本地运行，不上传账号数据或认证信息。

## 重点内容

EOF

highlight_count=0
for highlight in "${highlights[@]}"; do
  printf -- '- %s\n' "${highlight}"
  highlight_count=$((highlight_count + 1))
  [[ ${highlight_count} -ge 5 ]] && break
done

printf '\n## 变更内容\n\n'
[[ ${#features[@]} -eq 0 ]] || print_category "新功能" "${features[@]}"
[[ ${#fixes[@]} -eq 0 ]] || print_category "修复" "${fixes[@]}"
[[ ${#improvements[@]} -eq 0 ]] || print_category "优化与调整" "${improvements[@]}"
[[ ${#engineering[@]} -eq 0 ]] || print_category "工程与文档" "${engineering[@]}"
[[ ${#others[@]} -eq 0 ]] || print_category "其他" "${others[@]}"

cat <<EOF
## 升级提醒

- 已安装用户可直接使用应用内更新，并在设置中选择 GitHub 或 CNB 更新源。
- 若应用内更新暂不可用，可下载对应平台的安装包覆盖安装。

## 下载与安装

请按操作系统和处理器架构选择安装包：

| 平台 | 架构 | 推荐安装包 |
| --- | --- | --- |
| macOS | Apple Silicon | \`Codex-Auth-Switch_${version}_macOS_arm64.dmg\` |
| macOS | Intel | \`Codex-Auth-Switch_${version}_macOS_x64.dmg\` |
| Windows | x64 | \`Codex-Auth-Switch_${version}_Windows_x64-setup.exe\`（推荐）或 \`Codex-Auth-Switch_${version}_Windows_x64.msi\` |
| Linux | x64 | \`Codex-Auth-Switch_${version}_Linux_x64.AppImage\`、\`Codex-Auth-Switch_${version}_Linux_x64.deb\` 或 \`Codex-Auth-Switch_${version}_Linux_x64.rpm\` |

> \`.app.tar.gz\`、\`.sig\` 和 \`latest.json\` 由应用内更新使用，手动安装时无需下载。

macOS 安装包目前使用 ad-hoc 签名。若首次启动被系统拦截，请前往“系统设置 → 隐私与安全性”确认打开。

## 官方发布渠道

| 渠道 | 地址 |
| --- | --- |
| GitHub | [${release_tag}](${github_url}/releases/tag/${release_tag}) |
| CNB | [${release_tag}](${cnb_url}/-/releases/${release_tag}) |

两个渠道提供相同版本。应用内更新可在设置中选择 GitHub 或 CNB，并继续通过 Tauri 更新签名校验安装包。

## 发布信息

- 发布日期：${release_date}
- 变更数量：${#commits[@]}
EOF

if [[ -n "${previous_tag}" ]]; then
  printf -- '- 完整变更：[%s...%s](%s/compare/%s...%s)\n' \
    "${previous_tag}" "${release_tag}" "${github_url}" "${previous_tag}" "${release_tag}"
fi
