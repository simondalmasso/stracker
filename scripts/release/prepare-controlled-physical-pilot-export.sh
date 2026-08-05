#!/usr/bin/env bash
set -euo pipefail

SOURCE_SHA="${SOURCE_SHA:?SOURCE_SHA required}"

python scripts/santa-fe-3d/validate_static_asset.py \
  --manifest public/data/santa-fe-3d/manifest.json \
  --root public
bun test tests/vector-map

echo 'SANTA_FE_3D_PIPELINE_AND_RUNTIME_CONTRACTS=PASS'

rm -rf out
mkdir -p public/__stracker
cleanup() {
  rm -f public/__stracker/build.json
  rmdir public/__stracker 2>/dev/null || true
}
trap cleanup EXIT

python - "$SOURCE_SHA" <<'PY'
import json
import sys
from pathlib import Path
Path('public/__stracker/build.json').write_text(json.dumps({
    'sourceSha': sys.argv[1],
    'release': 'controlled-physical-pilot-v1',
}, sort_keys=True) + '\n')
PY

NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_STRACKER_SHARED_RUNTIME=enabled bun run build:export
cleanup
trap - EXIT

rm -f \
  out/gemini-analysis-input.json \
  out/s-tracker-extension.zip \
  out/mapa.html \
  out/mapa_v10.html

while IFS= read -r path; do
  name="${path#out/}"
  case "$name" in
    index.html|404.html|_not-found.html|share.html|shared.html|manifest.json|robots.txt|logo.svg|_headers|_redirects|*.txt)
      ;;
    *)
      echo "UNEXPECTED_CONTROLLED_PILOT_RELEASE_ROOT_FILE=$name"
      exit 1
      ;;
  esac
done < <(find out -maxdepth 1 -type f -print | LC_ALL=C sort)

for required in \
  out/index.html \
  out/share/index.html \
  out/shared/index.html \
  out/__stracker/build.json \
  out/data/santa-fe-3d/manifest.json; do
  test -f "$required"
done

python scripts/santa-fe-3d/validate_static_asset.py \
  --manifest out/data/santa-fe-3d/manifest.json \
  --root out

python - <<'PY'
import json
from pathlib import Path
manifest = json.loads(Path('out/data/santa-fe-3d/manifest.json').read_text())
assert manifest['final_features'] >= 200_000
assert manifest['unique_height_bucket_count'] >= 6
assert manifest['uniform_default_height_fraction'] < 0.35
assert manifest['asset_shard_count'] == len(manifest['asset_paths']) >= 2
assert all(path.startswith('/data/santa-fe-3d/') and path.endswith('.pmtiles') for path in manifest['asset_paths'])
assert all(size < 25 * 1024 * 1024 for size in manifest['asset_sizes'])
print('SANTA_FE_DENSE_CITY_STATIC_EXPORT=PASS')
PY

if find out -type f \( \
  -name '.env*' -o \
  -name '*.zip' -o \
  -name '*.log' -o \
  -name '*.map' -o \
  -name '*.pem' -o \
  -name '*.key' \
\) -print -quit | grep -q .; then
  echo 'FORBIDDEN_CONTROLLED_PILOT_RELEASE_ASSET_PRESENT'
  exit 1
fi

test ! -e out/.git
test ! -e out/.github

CHROME_BIN="${CHROME_BIN:-$(command -v google-chrome || command -v chromium || command -v chromium-browser)}"
test -n "$CHROME_BIN"
export CHROME_BIN
VALIDATION_EVIDENCE_DIR="${RUNNER_TEMP:-/tmp}/stracker-controlled-pilot-validation"
mkdir -p "$VALIDATION_EVIDENCE_DIR"
STRACKER_MAP3D_QA_OUTPUT="$VALIDATION_EVIDENCE_DIR/santa-fe-dense-city-qa.json" \
STRACKER_MAP3D_SCREENSHOT_DIR="$VALIDATION_EVIDENCE_DIR" \
  bun tests/native-sharing-cloudflare/map-3d-runtime-qa.ts
jq -e '.privateDataUsed == false and .realUserCoordinatesUsed == false and .coordinateValuesRetained == false' "$VALIDATION_EVIDENCE_DIR/santa-fe-dense-city-qa.json" >/dev/null
jq -e '.featureCount >= 200000 and .uniqueHeightBucketCount >= 6 and .uniformDefaultHeightFraction < 0.35' "$VALIDATION_EVIDENCE_DIR/santa-fe-dense-city-qa.json" >/dev/null
jq -e '.localRange.requests > 0 and .localRange.fullRequests == 0 and .localRange.contentRangeFailures == 0' "$VALIDATION_EVIDENCE_DIR/santa-fe-dense-city-qa.json" >/dev/null
jq -e '[.gates[] | select(. != "PASS")] | length == 0' "$VALIDATION_EVIDENCE_DIR/santa-fe-dense-city-qa.json" >/dev/null
test -s "$VALIDATION_EVIDENCE_DIR/santa-fe-dense-city-on.png"
test -s "$VALIDATION_EVIDENCE_DIR/santa-fe-dense-city-off.png"
echo 'SANTA_FE_DENSE_CITY_AUTOMATED=PASS'
COOKIE_SESSION_BROWSER_QA_OUTPUT="${COOKIE_SESSION_BROWSER_QA_OUTPUT:-${RUNNER_TEMP:-/tmp}/stracker-cookie-session-browser.json}"
export COOKIE_SESSION_BROWSER_QA_OUTPUT
bun tests/native-sharing-cloudflare/cookie-session-browser-qa.ts
jq -e '.privateDataUsed == false and .realCookieValuesUsed == false and .realCoordinatesUsed == false and .cookieValuesRetained == false' "$COOKIE_SESSION_BROWSER_QA_OUTPUT" >/dev/null
jq -e '.pageErrorTotal == 0 and .relevantConsoleErrors == 0 and .unexpectedNetworkErrors == 0 and .appApi404Total == 0 and .horizontalOverflowTotal == 0 and .fakeSuccessTotal == 0' "$COOKIE_SESSION_BROWSER_QA_OUTPUT" >/dev/null
jq -e '[.gates[] | select(. != "PASS")] | length == 0' "$COOKIE_SESSION_BROWSER_QA_OUTPUT" >/dev/null

echo 'CONTROLLED_PILOT_RELEASE_ASSET_ALLOWLIST=PASS'
echo 'CONTROLLED_PILOT_UI_ENABLED=PASS'
echo 'COOKIE_SESSION_BROWSER_QA=PASS'
