#!/usr/bin/env bash

set -euo pipefail

: "${CNB_REPO:?CNB_REPO is required}"
: "${CNB_TOKEN:?CNB_TOKEN is required}"
: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${RELEASE_NAME:?RELEASE_NAME is required}"
: "${RELEASE_ASSETS_DIR:?RELEASE_ASSETS_DIR is required}"

CNB_CLI_VERSION="${CNB_CLI_VERSION:-1.10.9}"
RELEASE_PRERELEASE="${RELEASE_PRERELEASE:-false}"
RELEASE_BODY="${RELEASE_BODY:-}"

cnb_cli() {
  npx --yes "@cnbcool/cnb-cli@${CNB_CLI_VERSION}" "$@"
}

response_status() {
  jq -r '.status // 0' <<<"$1"
}

require_status() {
  local response="$1"
  shift
  local actual
  actual="$(response_status "$response")"

  for expected in "$@"; do
    if [[ "$actual" == "$expected" ]]; then
      return 0
    fi
  done

  echo "CNB API returned unexpected status ${actual}" >&2
  jq -c '{status, data}' <<<"$response" >&2
  return 1
}

release_payload="$(jq -cn \
  --arg tag_name "$RELEASE_TAG" \
  --arg name "$RELEASE_NAME" \
  --arg body "$RELEASE_BODY" \
  --arg target_commitish "$RELEASE_TAG" \
  --argjson prerelease "$RELEASE_PRERELEASE" \
  '{
    tag_name: $tag_name,
    target_commitish: $target_commitish,
    name: $name,
    body: $body,
    draft: false,
    prerelease: $prerelease,
    make_latest: "true"
  }')"

release_response="$(
  cnb_cli releases get-release-by-tag \
    --repo "$CNB_REPO" \
    --tag "$RELEASE_TAG" \
    --verbose
)"

if [[ "$(response_status "$release_response")" == "200" ]]; then
  release_id="$(jq -r '.data.id' <<<"$release_response")"
  existing_assets="$(jq -c '.data.assets // []' <<<"$release_response")"
  update_payload="$(jq -cn \
    --arg name "$RELEASE_NAME" \
    --arg body "$RELEASE_BODY" \
    --argjson prerelease "$RELEASE_PRERELEASE" \
    '{
      name: $name,
      body: $body,
      draft: false,
      prerelease: $prerelease,
      make_latest: "true"
    }')"
  update_response="$(
    cnb_cli releases patch-release \
      --repo "$CNB_REPO" \
      --release-id "$release_id" \
      --data "$update_payload" \
      --verbose
  )"
  require_status "$update_response" 200
else
  require_status "$release_response" 404
  create_response="$(
    cnb_cli releases post-release \
      --repo "$CNB_REPO" \
      --data "$release_payload" \
      --verbose
  )"
  require_status "$create_response" 201
  release_id="$(jq -r '.data.id' <<<"$create_response")"
  existing_assets="[]"
fi

shopt -s nullglob
assets=("${RELEASE_ASSETS_DIR}"/*)
if (( ${#assets[@]} == 0 )); then
  echo "No GitHub Release assets found in ${RELEASE_ASSETS_DIR}" >&2
  exit 1
fi

for asset in "${assets[@]}"; do
  asset_name="$(basename "$asset")"
  asset_size="$(wc -c <"$asset" | tr -d '[:space:]')"
  existing_size="$(
    jq -r --arg name "$asset_name" \
      '[.[] | select(.name == $name) | .size][0] // 0' \
      <<<"$existing_assets"
  )"

  if [[ "$existing_size" == "$asset_size" ]]; then
    echo "Skipped unchanged asset ${asset_name}"
    continue
  fi

  upload_response="$(
    cnb_cli releases post-release-asset-upload-url \
      --repo "$CNB_REPO" \
      --release-id "$release_id" \
      --asset-name "$asset_name" \
      --size "$asset_size" \
      --ttl 0 \
      --overwrite \
      --verbose
  )"
  require_status "$upload_response" 201

  upload_url="$(jq -r '.data.upload_url' <<<"$upload_response")"
  verify_url="$(jq -r '.data.verify_url' <<<"$upload_response")"

  curl --fail --silent --show-error \
    --retry 3 \
    --request PUT \
    --upload-file "$asset" \
    "$upload_url"

  verify_path="$(node -e 'console.log(decodeURIComponent(new URL(process.argv[1]).pathname))' "$verify_url")"
  verify_suffix="${verify_path#*/asset-upload-confirmation/}"
  upload_token="${verify_suffix%%/*}"
  asset_path="${verify_suffix#*/}"

  if [[ -z "$upload_token" || -z "$asset_path" || "$asset_path" == "$verify_suffix" ]]; then
    echo "Could not parse the CNB upload confirmation URL" >&2
    exit 1
  fi

  confirm_response="$(
    cnb_cli releases post-release-asset-upload-confirmation \
      --repo "$CNB_REPO" \
      --release-id "$release_id" \
      --upload-token "$upload_token" \
      --asset-path "$asset_path" \
      --ttl 0 \
      --verbose
  )"
  require_status "$confirm_response" 200
  echo "Uploaded ${asset_name} to CNB Release ${RELEASE_TAG}"
done

final_response="$(
  cnb_cli releases get-release-by-tag \
    --repo "$CNB_REPO" \
    --tag "$RELEASE_TAG" \
    --verbose
)"
require_status "$final_response" 200

expected_assets="${#assets[@]}"
actual_assets="$(jq '.data.assets | length' <<<"$final_response")"
if (( actual_assets < expected_assets )); then
  echo "CNB Release has ${actual_assets} assets; expected at least ${expected_assets}" >&2
  exit 1
fi

echo "CNB Release ${RELEASE_TAG} is ready with ${actual_assets} assets"
