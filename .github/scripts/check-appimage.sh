#!/usr/bin/env bash
set -euo pipefail

image_path="$(realpath "${1:?需要指定 AppImage 文件}")"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
audit_dir="$(mktemp -d /tmp/codex-appimage-check.XXXXXX)"
trap 'rm -rf -- "${audit_dir}"' EXIT

# 读取最终产物，而不是构建时的 AppDir；不修改已签名的内容。
offset="$("${image_path}" --appimage-offset)"
if [[ ! "${offset}" =~ ^[0-9]+$ ]]; then
  echo "::error::无法读取 AppImage 的 SquashFS 偏移"
  exit 1
fi
unsquashfs -no-progress -o "${offset}" -d "${audit_dir}/AppDir" "${image_path}" >/dev/null
node "${script_dir}/check-appimage-permissions.mjs" "${audit_dir}/AppDir"

cp -- "${image_path}" "${audit_dir}/application.AppImage"
cp -- "${script_dir}/smoke-appimage.sh" "${audit_dir}/smoke.sh"
mkdir -p "${audit_dir}/home"
user_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
if [[ -z "${user_home}" || "${user_home}" == / ]]; then
  echo "::error::无法定位测试用户的主目录"
  exit 1
fi

# 在独立挂载/进程/网络命名空间内，用空目录覆盖真实用户主目录。
# 清空凭据、代理等环境变量，测试进程不会访问本机 Codex 登录或网络。
# 使用解包启动以避免 CI 对 FUSE 的限制；权限必须先通过上面的独立检查。
if ! timeout --signal=TERM --kill-after=5s 90s \
  bwrap --die-with-parent --new-session --unshare-pid --unshare-net \
  --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
  --bind "${audit_dir}" "${audit_dir}" \
  --bind "${audit_dir}/home" "${user_home}" \
  --clearenv --setenv PATH /usr/bin:/bin \
  --setenv XDG_CONFIG_HOME "${audit_dir}/home/.config" \
  --setenv XDG_DATA_HOME "${audit_dir}/home/.local/share" \
  --setenv XDG_CACHE_HOME "${audit_dir}/home/.cache" \
  --setenv APPIMAGE_EXTRACT_AND_RUN 1 \
  --setenv GDK_BACKEND x11 --setenv LIBGL_ALWAYS_SOFTWARE 1 \
  --chdir "${audit_dir}" \
  dbus-run-session -- xvfb-run -a bash "${audit_dir}/smoke.sh" \
  "${audit_dir}/application.AppImage" >"${audit_dir}/smoke.log" 2>&1; then
  cat "${audit_dir}/smoke.log"
  echo "::error::AppImage 隔离启动检查失败"
  exit 1
fi
echo "AppImage 权限和隔离启动检查通过"
