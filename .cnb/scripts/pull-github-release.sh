#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_REPOSITORY_SLUG:?GITHUB_REPOSITORY_SLUG is required}"
: "${TARGET_CNB_REPO:?TARGET_CNB_REPO is required}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${RELEASE_ASSETS_DIR:?RELEASE_ASSETS_DIR is required}"
: "${GITHUB_RELEASE_METADATA_FILE:?GITHUB_RELEASE_METADATA_FILE is required}"

release_tag="${RELEASE_TAG#refs/tags/}"
wait_seconds="${GITHUB_RELEASE_WAIT_SECONDS:-900}"
poll_seconds="${GITHUB_RELEASE_POLL_SECONDS:-15}"

if [[ ! "${release_tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Release tag must look like vX.Y.Z, got: ${release_tag}" >&2
  exit 1
fi
if [[ ! "${wait_seconds}" =~ ^[0-9]+$ || ! "${poll_seconds}" =~ ^[1-9][0-9]*$ ]]; then
  echo "GitHub Release wait settings must be positive integers" >&2
  exit 1
fi

mkdir -p "${RELEASE_ASSETS_DIR}"
find "${RELEASE_ASSETS_DIR}" -mindepth 1 -maxdepth 1 -type f -delete
mkdir -p "$(dirname "${GITHUB_RELEASE_METADATA_FILE}")"

manifest="${RELEASE_ASSETS_DIR}/latest.json"
manifest_download="${manifest}.download"
manifest_url="https://github.com/${GITHUB_REPOSITORY_SLUG}/releases/download/${release_tag}/latest.json"
deadline=$((SECONDS + wait_seconds))
attempt=0

while true; do
  attempt=$((attempt + 1))
  http_status="$(
    curl --location --silent \
      --connect-timeout 20 \
      --max-time 120 \
      --output "${manifest_download}" \
      --write-out '%{http_code}' \
      "${manifest_url}" || true
  )"

  if [[ "${http_status}" == "200" ]]; then
    mv "${manifest_download}" "${manifest}"
    break
  fi

  if (( SECONDS >= deadline )); then
    echo "GitHub Release ${release_tag} was not ready after ${wait_seconds}s (last HTTP status: ${http_status:-000})" >&2
    exit 1
  fi

  if (( attempt == 1 || attempt % 4 == 0 )); then
    echo "Waiting for published GitHub Release ${release_tag} (HTTP ${http_status:-000})"
  fi
  sleep "${poll_seconds}"
done

version="${release_tag#v}"
jq -e \
  --arg version "${version}" \
  '
    .version == $version
    and (.platforms | type == "object" and length > 0)
    and all(.platforms[];
      (.url | type == "string" and length > 0)
      and (.signature | type == "string" and length > 0)
    )
  ' \
  "${manifest}" >/dev/null

expected_assets=(
  "Codex-Auth-Switch_${version}_Linux_x64.AppImage"
  "Codex-Auth-Switch_${version}_Linux_x64.AppImage.sig"
  "Codex-Auth-Switch_${version}_Linux_x64.deb"
  "Codex-Auth-Switch_${version}_Linux_x64.deb.sig"
  "Codex-Auth-Switch_${version}_Linux_x64.rpm"
  "Codex-Auth-Switch_${version}_Linux_x64.rpm.sig"
  "Codex-Auth-Switch_${version}_macOS_arm64.app.tar.gz"
  "Codex-Auth-Switch_${version}_macOS_arm64.app.tar.gz.sig"
  "Codex-Auth-Switch_${version}_macOS_arm64.dmg"
  "Codex-Auth-Switch_${version}_macOS_x64.app.tar.gz"
  "Codex-Auth-Switch_${version}_macOS_x64.app.tar.gz.sig"
  "Codex-Auth-Switch_${version}_macOS_x64.dmg"
  "Codex-Auth-Switch_${version}_Windows_x64-setup.exe"
  "Codex-Auth-Switch_${version}_Windows_x64-setup.exe.sig"
  "Codex-Auth-Switch_${version}_Windows_x64.msi"
  "Codex-Auth-Switch_${version}_Windows_x64.msi.sig"
  "latest.json"
)

for asset_name in "${expected_assets[@]}"; do
  if [[ "${asset_name}" == "latest.json" ]]; then
    continue
  fi
  if [[ -z "${asset_name}" || "${asset_name}" == "." || "${asset_name}" == ".." || "${asset_name}" == */* ]]; then
    echo "Unsafe GitHub Release asset name: ${asset_name}" >&2
    exit 1
  fi

  asset_url="https://github.com/${GITHUB_REPOSITORY_SLUG}/releases/download/${release_tag}/${asset_name}"
  destination="${RELEASE_ASSETS_DIR}/${asset_name}"
  partial="${destination}.download"
  echo "Downloading ${asset_name} from GitHub"
  curl --fail --location --silent --show-error \
    --retry 5 \
    --retry-all-errors \
    --connect-timeout 30 \
    --max-time 1800 \
    --output "${partial}" \
    "${asset_url}"
  mv "${partial}" "${destination}"
  if [[ ! -s "${destination}" ]]; then
    echo "Downloaded GitHub Release asset is empty: ${asset_name}" >&2
    exit 1
  fi
done

git fetch --force --tags \
  "https://github.com/${GITHUB_REPOSITORY_SLUG}.git" \
  '+refs/tags/*:refs/tags/*'
previous_tag="$(git describe --tags --abbrev=0 "${release_tag}^" 2>/dev/null || true)"
release_body="$(
  bash .github/scripts/generate-release-notes.sh \
    "${release_tag}" "${previous_tag}"
)"
if [[ "${release_tag}" == *-* ]]; then
  release_prerelease=true
else
  release_prerelease=false
fi
jq -n \
  --arg tag_name "${release_tag}" \
  --arg name "${release_tag}" \
  --arg body "${release_body}" \
  --argjson prerelease "${release_prerelease}" \
  '{
    tag_name: $tag_name,
    name: $name,
    body: $body,
    draft: false,
    prerelease: $prerelease
  }' > "${GITHUB_RELEASE_METADATA_FILE}"

jq \
  --arg cnb_repo "${TARGET_CNB_REPO}" \
  --arg tag "${release_tag}" \
  --arg version "${version}" \
  '
    {
      "darwin-aarch64": "Codex-Auth-Switch_\($version)_macOS_arm64.app.tar.gz",
      "darwin-aarch64-app": "Codex-Auth-Switch_\($version)_macOS_arm64.app.tar.gz",
      "darwin-x86_64": "Codex-Auth-Switch_\($version)_macOS_x64.app.tar.gz",
      "darwin-x86_64-app": "Codex-Auth-Switch_\($version)_macOS_x64.app.tar.gz",
      "linux-x86_64": "Codex-Auth-Switch_\($version)_Linux_x64.AppImage",
      "linux-x86_64-appimage": "Codex-Auth-Switch_\($version)_Linux_x64.AppImage",
      "linux-x86_64-deb": "Codex-Auth-Switch_\($version)_Linux_x64.deb",
      "linux-x86_64-rpm": "Codex-Auth-Switch_\($version)_Linux_x64.rpm",
      "windows-x86_64": "Codex-Auth-Switch_\($version)_Windows_x64-setup.exe",
      "windows-x86_64-nsis": "Codex-Auth-Switch_\($version)_Windows_x64-setup.exe",
      "windows-x86_64-msi": "Codex-Auth-Switch_\($version)_Windows_x64.msi"
    } as $asset_names
    | .platforms |= with_entries(
        .key as $platform
        | ($asset_names[$platform]
          // error("找不到更新平台对应的 Release 附件：\($platform)")) as $asset_name
        | .value.url = (
            "https://cnb.cool/" + $cnb_repo
            + "/-/releases/download/" + ($tag | @uri)
            + "/" + ($asset_name | @uri)
          )
      )
  ' \
  "${manifest}" > "${manifest}.rewritten"
mv "${manifest}.rewritten" "${manifest}"

jq -e \
  --arg prefix "https://cnb.cool/${TARGET_CNB_REPO}/-/releases/download/${release_tag}/" \
  '
    (.platforms | type == "object" and length > 0)
    and all(.platforms[].url; startswith($prefix))
  ' \
  "${manifest}" >/dev/null

actual_assets="$(
  find "${RELEASE_ASSETS_DIR}" -mindepth 1 -maxdepth 1 -type f \
    ! -name '*.download' \
    ! -name '*.rewritten' \
    | wc -l \
    | tr -d '[:space:]'
)"
if [[ "${actual_assets}" != "${#expected_assets[@]}" ]]; then
  echo "Downloaded ${actual_assets} GitHub assets; expected ${#expected_assets[@]}" >&2
  exit 1
fi

echo "GitHub Release ${release_tag} is ready with ${actual_assets} assets"
