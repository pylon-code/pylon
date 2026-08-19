#!/usr/bin/env bash
# Read-only. Answers "what is on the phone, how stale is it, and does it need a
# rebuild?" in one pass. Spends no EAS build quota and changes nothing on the
# device. Every mutating decision belongs to the human.
set -euo pipefail

readonly CHANNEL="${PYLON_MOBILE_CHANNEL:-preview}"
readonly PROFILE="${PYLON_MOBILE_PROFILE:-preview:local}"

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root/apps/mobile"

if ! command -v eas >/dev/null 2>&1; then
  echo "eas not on PATH. Install it once with:" >&2
  echo "  npm install -g eas-cli" >&2
  echo "Do not use 'npx eas-cli' from this repo: the react-native-nitro-markdown" >&2
  echo "override makes npm fail with EOVERRIDE before eas ever runs." >&2
  exit 1
fi

if ! expo_user="$(eas whoami 2>/dev/null)"; then
  echo "Not logged in to Expo. Run: eas login" >&2
  exit 1
fi
expo_user="$(tr -d '[:space:]' <<<"$expo_user")"

# The build page lives under the project owner, which is not necessarily the
# logged-in account. .env.local is the same source app.config.ts reads.
owner="$(sed -n 's/^PYLON_EAS_OWNER=//p' "$repo_root/.env.local" 2>/dev/null | tr -d '"'"'"'[:space:]')"
owner="${owner:-$expo_user}"

echo "== Build currently published to channel '$CHANNEL' =="
build_json="$(APP_VARIANT=preview eas build:list \
  --platform ios --status finished --channel "$CHANNEL" \
  --limit 1 --json --non-interactive 2>/dev/null)"

# Emits shell assignments so the JSON shape stays in one place.
eval "$(node -e '
  let raw = "";
  process.stdin.on("data", (d) => (raw += d)).on("end", () => {
    const build = JSON.parse(raw)[0];
    if (!build) {
      console.log("BUILD_ID=; BUILD_COMMIT=; BUILD_FINGERPRINT=");
      return;
    }
    const q = (v) => JSON.stringify(String(v ?? ""));
    console.log(`BUILD_ID=${q(build.id)}`);
    console.log(`BUILD_COMMIT=${q(build.gitCommitHash)}`);
    console.log(`BUILD_PROFILE=${q(build.buildProfile)}`);
    console.log(`BUILD_RUNTIME=${q(build.runtimeVersion)}`);
    console.log(`BUILD_FINISHED=${q(build.completedAt)}`);
    console.log(`BUILD_FINGERPRINT=${q(build.fingerprint?.hash)}`);
    console.log(`BUILD_IPA=${q(build.artifacts?.applicationArchiveUrl)}`);
  });
' <<<"$build_json")"

if [[ -z "${BUILD_ID:-}" ]]; then
  echo "No finished iOS build on channel '$CHANNEL'. A first build is required."
  exit 0
fi

cat <<EOF
  id          $BUILD_ID
  profile     $BUILD_PROFILE
  runtime     $BUILD_RUNTIME
  commit      $BUILD_COMMIT
  finished    $BUILD_FINISHED
  install     https://expo.dev/accounts/$owner/projects/pylon/builds/$BUILD_ID
EOF

echo
echo "== Source drift =="
git fetch origin pylon --quiet 2>/dev/null || echo "  (fetch failed; comparing against local refs)"
if git cat-file -e "${BUILD_COMMIT}^{commit}" 2>/dev/null; then
  behind="$(git rev-list --count "${BUILD_COMMIT}..origin/pylon" 2>/dev/null || echo "?")"
  echo "  $behind commit(s) on origin/pylon are not in that build"
  contracts="$(git diff --name-only "${BUILD_COMMIT}..origin/pylon" -- ../../packages/contracts 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$contracts" != "0" ]]; then
    echo "  $contracts contract file(s) changed — an older client may not decode what the server now sends"
  fi
else
  echo "  Build commit $BUILD_COMMIT is not in this checkout (fetch it to compare)."
fi

echo
echo "== Native fingerprint =="
local_fp="$(APP_VARIANT=preview eas fingerprint:generate \
  --platform ios --build-profile "$PROFILE" --json --non-interactive 2>/dev/null \
  | node -e 'let r="";process.stdin.on("data",d=>r+=d).on("end",()=>{try{console.log(JSON.parse(r).hash??"")}catch{console.log("")}})')"

echo "  on phone  ${BUILD_FINGERPRINT:-<none recorded>}"
echo "  local     ${local_fp:-<could not compute>}"
echo

if [[ -z "$local_fp" || -z "${BUILD_FINGERPRINT:-}" ]]; then
  echo "VERDICT: UNKNOWN — could not compare fingerprints. Treat as REBUILD."
elif [[ "$local_fp" == "$BUILD_FINGERPRINT" ]]; then
  echo "VERDICT: OTA SAFE — native side matches. A JS-only update may be published."
else
  echo "VERDICT: REBUILD REQUIRED — native inputs changed since that build."
  echo "         Publishing an OTA would ship JS whose native counterpart is missing."
  echo "         See exactly what moved:"
  echo "           eas fingerprint:compare --build-id $BUILD_ID"
fi
