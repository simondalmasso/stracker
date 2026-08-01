#!/usr/bin/env bash
set -euo pipefail

SOURCE_SHA="${SOURCE_SHA:?SOURCE_SHA required}"
FROZEN_BASE_SHA='53cef936fe416519861f4889ddc2898468f24723'
FROZEN_BASE_BRANCH='feat/stracker-native-sharing-worker-sqlite-e2e-v1'
RELEASE_CONFIG='native-sharing-cloudflare/wrangler.release.jsonc'
TEMP="${RUNNER_TEMP:-/tmp}"

# Exact remote lineage.
test "$(git rev-parse HEAD)" = "$SOURCE_SHA"
git fetch origin "$FROZEN_BASE_BRANCH" --no-tags
test "$(git rev-parse "origin/$FROZEN_BASE_BRANCH")" = "$FROZEN_BASE_SHA"
test "$(git merge-base HEAD "origin/$FROZEN_BASE_BRANCH")" = "$FROZEN_BASE_SHA"
test "$(git rev-list --count HEAD.."origin/$FROZEN_BASE_BRANCH")" = '0'
git diff --check "$FROZEN_BASE_SHA"...HEAD
echo 'EXACT_HEAD_AND_BASE=PASS'

bun install --frozen-lockfile
git diff --exit-code -- package.json bun.lock
echo 'FROZEN_INSTALL=PASS'

python -m pip install --disable-pip-version-check -r requirements.txt
python -m py_compile tracker_map.py nextjs-ui/tracker_map.py stracker_security.py stracker_session.py
python -m unittest discover -s tests -p 'test_*.py'
cmp tracker_map.py nextjs-ui/tracker_map.py
echo 'BACKEND_TESTS=PASS'

bun run lint
bunx eslint native-sharing/src native-sharing-cloudflare/src scripts/release/minimum-runtime-qa.ts tests/native-sharing-cloudflare/worker-sqlite-e2e.test.ts
generated_types='native-sharing-cloudflare/worker-configuration.d.ts'
trap 'rm -f "$generated_types"' EXIT
bunx wrangler@4.111.0 types "$generated_types" --config native-sharing-cloudflare/wrangler.jsonc
bun run typecheck
bunx tsc -p native-sharing/tsconfig.json
bunx tsc -p native-sharing-cloudflare/tsconfig.json
rm -f "$generated_types"
trap - EXIT
echo 'LINT=PASS'
echo 'TYPECHECK=PASS'

bun test tests/native-sharing/native-sharing.test.ts
bun test tests/native-sharing-cloudflare/runtime.test.ts
bun run test:native-sharing-cloudflare:vitest
bunx vitest run --config native-sharing-cloudflare/vitest.e2e.config.mts
echo 'NATIVE_SHARING_TESTS=PASS'
echo 'WORKERD_SQLITE_TESTS=PASS'
echo 'WORKER_SQLITE_E2E=PASS'

NEXT_TELEMETRY_DISABLED=1 bun run build:export
test -f out/index.html
test -f out/share/index.html
test -f out/shared/index.html
node tools/map-spike/release-bundle-gate.mjs
export CHROME_BIN="$(command -v google-chrome || command -v chromium || command -v chromium-browser)"
test -n "$CHROME_BIN"
QA_CLOUDFLARE_OUTPUT="$TEMP/full-browser-qa.json" bun tests/native-sharing-cloudflare/browser-runtime-qa.ts
jq -e '.pageErrorTotal == 0 and .horizontalOverflowTotal == 0 and .privateDataUsed == false and .coordinateValuesRetained == false and .secretValuesRetained == false' "$TEMP/full-browser-qa.json" >/dev/null
echo 'FULL_PRODUCT_BUILD=PASS'
echo 'FULL_BROWSER_QA=PASS'

python tests/security/test_native_sharing_cloudflare_artifact.py
python tests/security/test_native_sharing_cloudflare_lifecycle_scan.py
python scripts/security/native-sharing-cloudflare-release-scan.py --root .
bun audit --audit-level high
python - <<'PY'
from pathlib import Path
import re
paths = [
    Path('native-sharing-cloudflare/src/minimal-worker.ts'),
    Path('native-sharing-cloudflare/wrangler.release.jsonc'),
    Path('scripts/release/cloudflare-same-domain-release.sh'),
    Path('scripts/release/minimum-runtime-qa.ts'),
    Path('scripts/release/validate-same-domain.sh'),
]
forbidden = re.compile(r'(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{20,}|CLOUDFLARE_API_TOKEN\s*=\s*[^$\s])')
if any(forbidden.search(path.read_text(errors='replace')) for path in paths):
    raise SystemExit('SECRET_SCAN_FAILED')
print('SECRET_SCAN=PASS')
PY
echo 'SECURITY_TESTS=PASS'
echo 'SECURITY_SCAN=PASS'
echo 'DEPENDENCY_SCAN=PASS'

python - <<'PY'
import json
from pathlib import Path
config = json.loads(Path('native-sharing-cloudflare/wrangler.release.jsonc').read_text())
assert config['name'] == 'stracker'
assert config['workers_dev'] is True
assert config['preview_urls'] is True
assert config.get('routes') == []
assert config['main'] == 'src/minimal-worker.ts'
assert config['assets']['directory'] == '../out'
assert config['assets']['binding'] == 'ASSETS'
for key in ('account_id', 'zone_id', 'exports', 'migrations', 'durable_objects', 'vars', 'secrets'):
    assert key not in config
print('RELEASE_CONFIG_INVARIANTS=PASS')
PY
bunx wrangler@4.111.0 deploy --dry-run --config "$RELEASE_CONFIG" --outdir "$TEMP/release-dry-run"
test -d "$TEMP/release-dry-run"
echo 'WRANGLER_DRY_RUN=PASS'

rm -rf out
mkdir -p public/__stracker
python - <<'PY'
import json, os
from pathlib import Path
Path('public/__stracker/build.json').write_text(json.dumps({
    'sourceSha': os.environ['SOURCE_SHA'],
    'release': 'same-domain-minimum-usable-v1',
}, sort_keys=True) + '\n')
PY
NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_STRACKER_SHARED_RUNTIME=disabled bun run build:export
rm -f public/__stracker/build.json
rmdir public/__stracker 2>/dev/null || true
bunx wrangler@4.111.0 dev --config "$RELEASE_CONFIG" --ip 127.0.0.1 --port 8791 > "$TEMP/wrangler-dev.log" 2>&1 &
dev_pid=$!
cleanup() { kill "$dev_pid" 2>/dev/null || true; }
trap cleanup EXIT
ready=0
for _ in {1..30}; do
  if ! kill -0 "$dev_pid" 2>/dev/null; then
    echo 'WRANGLER_DEV_EXITED_EARLY'
    sed -E 's/[A-Za-z0-9_-]{32,}/[REDACTED]/g' "$TEMP/wrangler-dev.log" | tail -40
    exit 1
  fi
  if curl --fail --silent http://127.0.0.1:8791/ >/dev/null; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != '1' ]]; then
  echo 'WRANGLER_DEV_READINESS_TIMEOUT'
  sed -E 's/[A-Za-z0-9_-]{32,}/[REDACTED]/g' "$TEMP/wrangler-dev.log" | tail -40
  exit 1
fi
STRACKER_QA_URL='http://127.0.0.1:8791/' \
STRACKER_EXPECTED_SHA="$SOURCE_SHA" \
STRACKER_QA_ALLOW_HTTP=1 \
STRACKER_QA_OUTPUT="$TEMP/minimum-local-qa.json" \
CHROME_BIN="$CHROME_BIN" \
bun scripts/release/minimum-runtime-qa.ts
jq -e '.pageErrorTotal == 0 and .horizontalOverflowTotal == 0 and .privateDataUsed == false and .realCoordinatesUsed == false and .gates.RUNTIME_SHA_MATCH == "PASS" and .gates.SHARED_LOCATION_FAIL_CLOSED == "PASS"' "$TEMP/minimum-local-qa.json" >/dev/null
cleanup
trap - EXIT
echo 'MINIMUM_RELEASE_LOCAL_QA=PASS'

EVIDENCE_DIR="$TEMP/stracker-minimum-validation"
mkdir -p "$EVIDENCE_DIR"
python - "$EVIDENCE_DIR" <<'PY'
import json, os, sys
from pathlib import Path
out = Path(sys.argv[1])
payload = {
    'schema': 'stracker.same-domain-minimum-validation.v1',
    'sourceSha': os.environ['SOURCE_SHA'],
    'privateDataUsed': False,
    'realCoordinatesUsed': False,
    'secretsExposed': False,
    'gates': {key: 'PASS' for key in (
        'EXACT_HEAD_AND_BASE','FROZEN_INSTALL','BACKEND_TESTS','LINT','TYPECHECK',
        'NATIVE_SHARING_TESTS','WORKERD_SQLITE_TESTS','WORKER_SQLITE_E2E',
        'FULL_PRODUCT_BUILD','FULL_BROWSER_QA','SECURITY_TESTS','SECURITY_SCAN',
        'DEPENDENCY_SCAN','SECRET_SCAN','RELEASE_CONFIG_INVARIANTS','WRANGLER_DRY_RUN',
        'MINIMUM_RELEASE_LOCAL_QA','ZERO_COST_MODEL','FINAL_INTEGRITY')},
}
(out/'validation.json').write_text(json.dumps(payload, indent=2, sort_keys=True)+'\n')
PY
(
  cd "$EVIDENCE_DIR"
  sha256sum validation.json > sha256sums.txt
  sha256sum -c sha256sums.txt
)
echo "VALIDATION_EVIDENCE_DIR=$EVIDENCE_DIR" >> "${GITHUB_ENV:-/dev/null}"
echo 'SANITIZED_ARTIFACT_SCAN=PASS'
echo 'FINAL_INTEGRITY=PASS'
