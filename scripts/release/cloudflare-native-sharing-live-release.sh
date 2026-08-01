#!/usr/bin/env bash
set -euo pipefail

PUBLIC_WORKER='stracker'
BACKEND_WORKER='stracker-native-sharing-backend'
ACCOUNT_SUBDOMAIN='simondalmasso44'
TARGET_URL='https://stracker.simondalmasso44.workers.dev/'
PUBLIC_CONFIG='native-sharing-cloudflare/wrangler.release.jsonc'
BACKEND_CONFIG='native-sharing-cloudflare/wrangler.backend.jsonc'
WRANGLER=(bunx wrangler@4.111.0)
SOURCE_SHA="${SOURCE_SHA:?SOURCE_SHA is required}"
STATE_DIR="${RUNNER_TEMP:-/tmp}/stracker-native-sharing-live-release"
API_QA_OUTPUT="$STATE_DIR/live-api-qa.json"
BROWSER_QA_OUTPUT="$STATE_DIR/live-browser-qa.json"
mkdir -p "$STATE_DIR"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo 'BLOCKER=CLOUDFLARE_SECRET_ENVIRONMENT_UNAVAILABLE'
  exit 1
fi

sanitize_tail() {
  local path="$1"
  sed -E \
    -e 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[ID_REDACTED]/gI' \
    -e 's/[A-Za-z0-9_-]{32,}/[VALUE_REDACTED]/g' \
    "$path" | tail -40
}

run_wrangler() {
  local output="$1"
  shift
  if ! "${WRANGLER[@]}" "$@" >"$output" 2>&1; then
    sanitize_tail "$output"
    return 1
  fi
}

api_get() {
  local path="$1"
  local output="$2"
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H 'Content-Type: application/json' \
    "https://api.cloudflare.com/client/v4${path}" > "$output"
  jq -e '.success == true' "$output" >/dev/null
}

api_get_optional() {
  local path="$1"
  local output="$2"
  local code
  code="$(curl --silent --show-error \
    -o "$output" \
    -w '%{http_code}' \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H 'Content-Type: application/json' \
    "https://api.cloudflare.com/client/v4${path}")"
  if [[ "$code" == '404' ]]; then
    return 1
  fi
  test "$code" = '200'
  jq -e '.success == true' "$output" >/dev/null
}

python - <<'PY'
import json
from pathlib import Path
backend = json.loads(Path('native-sharing-cloudflare/wrangler.backend.jsonc').read_text())
public = json.loads(Path('native-sharing-cloudflare/wrangler.release.jsonc').read_text())
assert backend['name'] == 'stracker-native-sharing-backend'
assert backend['main'] == 'src/index.ts'
assert backend['workers_dev'] is False
assert backend['preview_urls'] is False
assert backend.get('routes') == []
assert backend['durable_objects']['bindings'] == [
    {'name': 'NATIVE_SHARING', 'class_name': 'NativeSharingDurableObject'},
]
assert backend['exports'] == {
    'NativeSharingDurableObject': {'type': 'durable-object', 'storage': 'sqlite'},
}
for forbidden in ('account_id', 'zone_id', 'assets', 'services', 'migrations'):
    assert forbidden not in backend
assert public['name'] == 'stracker'
assert public['main'] == 'src/minimal-worker.ts'
assert public['workers_dev'] is True
assert public['preview_urls'] is False
assert public.get('routes') == []
assert public['assets']['binding'] == 'ASSETS'
assert public['version_metadata']['binding'] == 'CF_VERSION_METADATA'
assert public['services'] == [
    {'binding': 'NATIVE_SHARING_BACKEND', 'service': 'stracker-native-sharing-backend'},
]
run_worker_first = set(public['assets']['run_worker_first'])
for required in ('/api/share/*', '/shared', '/shared/*', '/__stracker/version.json', '/__stracker/build.json'):
    assert required in run_worker_first
for forbidden in ('account_id', 'zone_id', 'exports', 'migrations', 'durable_objects'):
    assert forbidden not in public
print('RELEASE_CONFIG_INVARIANTS=PASS')
PY

api_get '/user/tokens/verify' "$STATE_DIR/token.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain" "$STATE_DIR/account-subdomain.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${PUBLIC_WORKER}/subdomain" "$STATE_DIR/public-subdomain-before.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${PUBLIC_WORKER}/deployments" "$STATE_DIR/public-deployments-before.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${PUBLIC_WORKER}/settings" "$STATE_DIR/public-settings-before.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains" "$STATE_DIR/domains-before.json"

python - "$STATE_DIR" <<'PY'
import json
import sys
from pathlib import Path
root = Path(sys.argv[1])
subdomain = json.loads((root/'account-subdomain.json').read_text())['result']['subdomain']
if subdomain != 'simondalmasso44':
    raise SystemExit('TARGET_ACCOUNT_SUBDOMAIN_MISMATCH')
public_subdomain = json.loads((root/'public-subdomain-before.json').read_text())['result']
if public_subdomain.get('enabled') is not True:
    raise SystemExit('PUBLIC_WORKERS_DEV_DISABLED')
payload = json.loads((root/'public-deployments-before.json').read_text())['result']
deployments = payload.get('deployments', payload if isinstance(payload, list) else [])
if not deployments:
    raise SystemExit('PUBLIC_ROLLBACK_BASELINE_UNAVAILABLE')
current = deployments[0]
versions = current.get('versions') or []
if len(versions) != 1:
    raise SystemExit('PUBLIC_DEPLOYMENT_NOT_SINGLE_VERSION')
item = versions[0]
version_id = item.get('version_id') or item.get('id')
if not version_id or float(item.get('percentage', -1)) != 100:
    raise SystemExit('PUBLIC_DEPLOYMENT_SHAPE_UNSUPPORTED')
(root/'public-rollback-specs.txt').write_text(f'{version_id}@100%\n')
(root/'public-previous-version-id.txt').write_text(version_id+'\n')
(root/'public-previous-deployment-id.txt').write_text(str(current.get('id') or 'unknown')+'\n')
settings = json.loads((root/'public-settings-before.json').read_text()).get('result') or {}
bindings = settings.get('bindings') or []
def name(binding):
    return binding.get('name') or binding.get('binding') or ''
assets = [item for item in bindings if item.get('type') == 'assets']
metadata = [item for item in bindings if item.get('type') == 'version_metadata']
if len(assets) != 1 or name(assets[0]) != 'ASSETS':
    raise SystemExit('PUBLIC_ASSETS_BINDING_NOT_EXACT')
if len(metadata) != 1 or name(metadata[0]) != 'CF_VERSION_METADATA':
    raise SystemExit('PUBLIC_VERSION_METADATA_BINDING_NOT_EXACT')
allowed = {'assets', 'plain_text', 'secret_text', 'secret_key', 'version_metadata'}
unexpected = sorted({str(item.get('type', 'unknown')) for item in bindings} - allowed)
if unexpected:
    raise SystemExit('UNSUPPORTED_PUBLIC_BINDINGS_BEFORE=' + ','.join(unexpected))
domains = json.loads((root/'domains-before.json').read_text()).get('result') or []
if isinstance(domains, dict):
    domains = domains.get('domains') or []
for worker in ('stracker', 'stracker-native-sharing-backend'):
    attached = [item for item in domains if item.get('service') == worker or item.get('worker') == worker]
    if attached:
        raise SystemExit('CUSTOM_DOMAIN_ATTACHED=' + worker)
print('PUBLIC_ROLLBACK_READY=PASS')
print('TARGET_ACCOUNT_AND_PUBLIC_WORKER=PASS')
print('CUSTOM_DOMAINS_ABSENT=PASS')
PY

backend_existed=0
if api_get_optional "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${BACKEND_WORKER}/settings" "$STATE_DIR/backend-settings-before.json"; then
  backend_existed=1
  api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${BACKEND_WORKER}/subdomain" "$STATE_DIR/backend-subdomain-before.json"
  run_wrangler "$STATE_DIR/backend-versions-before.json" versions list --name "$BACKEND_WORKER" --json
  python - "$STATE_DIR" <<'PY'
import json
import sys
from pathlib import Path
root = Path(sys.argv[1])
settings = json.loads((root/'backend-settings-before.json').read_text()).get('result') or {}
bindings = settings.get('bindings') or []
def name(binding):
    return binding.get('name') or binding.get('binding') or ''
do = [item for item in bindings if item.get('type') in ('durable_object_namespace', 'durable_object')]
if len(do) != 1 or name(do[0]) != 'NATIVE_SHARING' or do[0].get('class_name') != 'NativeSharingDurableObject':
    raise SystemExit('BACKEND_WORKER_NAME_ALREADY_OWNED_BY_UNRELATED_RESOURCE')
subdomain = json.loads((root/'backend-subdomain-before.json').read_text()).get('result') or {}
if subdomain.get('enabled') is not False:
    raise SystemExit('BACKEND_PUBLIC_INGRESS_ALREADY_ENABLED')
items = json.loads((root/'backend-versions-before.json').read_text())
if isinstance(items, dict):
    items = items.get('versions') or items.get('result') or []
owned = False
for item in items:
    annotations = item.get('annotations') or item.get('metadata', {}).get('annotations') or {}
    message = item.get('message') or annotations.get('workers/message') or ''
    if str(message).startswith('STRACKER native-sharing-backend '):
        owned = True
        break
if not owned:
    raise SystemExit('BACKEND_WORKER_NAME_ALREADY_OWNED_BY_UNRELATED_RESOURCE')
print('EXISTING_BACKEND_OWNERSHIP=PASS')
PY
else
  echo 'BACKEND_NAME_AVAILABLE=PASS'
fi

echo "BACKEND_EXISTED_BEFORE=$backend_existed" > "$STATE_DIR/backend-preexistence.txt"

run_wrangler "$STATE_DIR/backend-deploy.log" deploy \
  --config "$BACKEND_CONFIG" \
  --keep-vars \
  --message "STRACKER native-sharing-backend ${SOURCE_SHA}"
echo 'PRIVATE_BACKEND_DEPLOY=PASS'

api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${BACKEND_WORKER}/settings" "$STATE_DIR/backend-settings-after.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${BACKEND_WORKER}/subdomain" "$STATE_DIR/backend-subdomain-after.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${BACKEND_WORKER}/deployments" "$STATE_DIR/backend-deployments-after.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains" "$STATE_DIR/domains-after-backend.json"
run_wrangler "$STATE_DIR/backend-versions-after.json" versions list --name "$BACKEND_WORKER" --json

python - "$STATE_DIR" "$SOURCE_SHA" <<'PY'
import hashlib
import json
import sys
from pathlib import Path
root, sha = Path(sys.argv[1]), sys.argv[2]
settings = json.loads((root/'backend-settings-after.json').read_text()).get('result') or {}
bindings = settings.get('bindings') or []
def name(binding):
    return binding.get('name') or binding.get('binding') or ''
do = [item for item in bindings if item.get('type') in ('durable_object_namespace', 'durable_object')]
if len(do) != 1 or name(do[0]) != 'NATIVE_SHARING' or do[0].get('class_name') != 'NativeSharingDurableObject':
    raise SystemExit('BACKEND_DURABLE_OBJECT_BINDING_MISMATCH')
subdomain = json.loads((root/'backend-subdomain-after.json').read_text()).get('result') or {}
if subdomain.get('enabled') is not False:
    raise SystemExit('BACKEND_PUBLIC_INGRESS_ENABLED')
domains = json.loads((root/'domains-after-backend.json').read_text()).get('result') or []
if isinstance(domains, dict):
    domains = domains.get('domains') or []
if any(item.get('service') == 'stracker-native-sharing-backend' or item.get('worker') == 'stracker-native-sharing-backend' for item in domains):
    raise SystemExit('BACKEND_CUSTOM_DOMAIN_PRESENT')
items = json.loads((root/'backend-versions-after.json').read_text())
if isinstance(items, dict):
    items = items.get('versions') or items.get('result') or []
match = None
expected = 'STRACKER native-sharing-backend ' + sha
for item in items:
    annotations = item.get('annotations') or item.get('metadata', {}).get('annotations') or {}
    message = item.get('message') or annotations.get('workers/message') or ''
    if message == expected:
        match = item
        break
if not match:
    raise SystemExit('BACKEND_DEPLOYED_VERSION_NOT_FOUND')
version_id = match.get('id') or match.get('version_id')
if not version_id:
    raise SystemExit('BACKEND_VERSION_ID_MISSING')
(root/'backend-version-id.txt').write_text(version_id+'\n')
(root/'backend-version-hash.txt').write_text(hashlib.sha256(version_id.encode()).hexdigest()+'\n')
print('BACKEND_WORKER_EXISTS=PASS')
print('BACKEND_PUBLIC_INGRESS=FALSE')
print('BACKEND_DURABLE_OBJECT_SQLITE=PASS')
PY

bash scripts/release/prepare-native-sharing-export.sh
node tools/map-spike/release-bundle-gate.mjs

test -f out/index.html
test -f out/share/index.html
test -f out/shared/index.html
test -f out/__stracker/build.json

TAG="same-domain-${SOURCE_SHA}"
run_wrangler "$STATE_DIR/public-upload.log" versions upload \
  --config "$PUBLIC_CONFIG" \
  --keep-vars \
  --tag "$TAG" \
  --message "STRACKER native-sharing-live ${SOURCE_SHA}"

run_wrangler "$STATE_DIR/public-versions-after-upload.json" versions list --name "$PUBLIC_WORKER" --json
python - "$STATE_DIR" "$TAG" <<'PY'
import json
import sys
from pathlib import Path
root, tag = Path(sys.argv[1]), sys.argv[2]
items = json.loads((root/'public-versions-after-upload.json').read_text())
if isinstance(items, dict):
    items = items.get('versions') or items.get('result') or []
match = None
for item in items:
    annotations = item.get('annotations') or item.get('metadata', {}).get('annotations') or {}
    item_tag = item.get('tag') or annotations.get('workers/tag')
    if item_tag == tag:
        match = item
        break
if not match:
    raise SystemExit('PUBLIC_UPLOADED_VERSION_NOT_FOUND')
version_id = match.get('id') or match.get('version_id')
if not version_id:
    raise SystemExit('PUBLIC_UPLOADED_VERSION_ID_MISSING')
(root/'public-candidate-version-id.txt').write_text(version_id+'\n')
print('PUBLIC_VERSION_UPLOAD=PASS')
PY
PUBLIC_VERSION_ID="$(cat "$STATE_DIR/public-candidate-version-id.txt")"

rollback_required=0
rollback() {
  local exit_code=$?
  if [[ "$rollback_required" == '1' ]]; then
    mapfile -t rollback_specs < "$STATE_DIR/public-rollback-specs.txt"
    run_wrangler "$STATE_DIR/public-rollback.log" versions deploy \
      "${rollback_specs[@]}" \
      --name "$PUBLIC_WORKER" \
      --message 'Automatic rollback after failed native-sharing candidate' \
      -y || true
    echo 'PUBLIC_ROLLBACK_EXECUTED=YES'
  fi
  exit "$exit_code"
}
trap rollback ERR

mapfile -t rollback_specs < "$STATE_DIR/public-rollback-specs.txt"
rollback_required=1
run_wrangler "$STATE_DIR/public-zero-percent.log" versions deploy \
  "${rollback_specs[0]}" \
  "${PUBLIC_VERSION_ID}@0%" \
  --name "$PUBLIC_WORKER" \
  --message 'STRACKER native-sharing zero-percent validation' \
  -y
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${PUBLIC_WORKER}/deployments" "$STATE_DIR/public-zero-deployments.json"
python - "$STATE_DIR" "$PUBLIC_VERSION_ID" <<'PY'
import json
import sys
from pathlib import Path
root, candidate = Path(sys.argv[1]), sys.argv[2]
payload = json.loads((root/'public-zero-deployments.json').read_text())['result']
deployments = payload.get('deployments', payload if isinstance(payload, list) else [])
if not deployments:
    raise SystemExit('ZERO_PERCENT_DEPLOYMENT_UNAVAILABLE')
current = deployments[0]
versions = current.get('versions') or []
match = [item for item in versions if (item.get('version_id') or item.get('id')) == candidate]
if len(match) != 1 or float(match[0].get('percentage', -1)) != 0:
    raise SystemExit('ZERO_PERCENT_CANDIDATE_MISMATCH')
(root/'public-zero-deployment-id.txt').write_text(str(current.get('id') or 'unknown')+'\n')
print('PUBLIC_ZERO_PERCENT_DEPLOYMENT=PASS')
PY

metadata_ready=0
for attempt in {1..30}; do
  metadata_path="$STATE_DIR/override-version-${attempt}.json"
  if curl --fail --silent --show-error --max-time 20 \
    -H "Cloudflare-Workers-Version-Overrides: ${PUBLIC_WORKER}=\"${PUBLIC_VERSION_ID}\"" \
    -H 'Accept: application/json' \
    -H 'Cache-Control: no-cache' \
    "${TARGET_URL}__stracker/version.json?candidate=${SOURCE_SHA:0:12}&attempt=${attempt}" \
    > "$metadata_path" 2>/dev/null; then
    if python - "$metadata_path" "$SOURCE_SHA" "$PUBLIC_VERSION_ID" "$TAG" <<'PY'
import json
import sys
from pathlib import Path
try:
    payload = json.loads(Path(sys.argv[1]).read_text())
except (json.JSONDecodeError, UnicodeDecodeError):
    raise SystemExit(1)
sha, version, tag = sys.argv[2:5]
raise SystemExit(0 if payload.get('sourceSha') == sha and payload.get('versionId') == version and payload.get('versionTag') == tag else 1)
PY
    then
      metadata_ready=1
      break
    fi
  fi
  sleep 2
done
test "$metadata_ready" = '1'
echo 'VERSION_METADATA_OVERRIDE=PASS'

asset_ready=0
for attempt in {1..30}; do
  build_path="$STATE_DIR/override-build-${attempt}.json"
  if curl --fail --silent --show-error --max-time 20 \
    -H "Cloudflare-Workers-Version-Overrides: ${PUBLIC_WORKER}=\"${PUBLIC_VERSION_ID}\"" \
    -H 'Accept: application/json' \
    -H 'Cache-Control: no-cache' \
    "${TARGET_URL}__stracker/build.json?candidate=${SOURCE_SHA:0:12}&attempt=${attempt}" \
    > "$build_path" 2>/dev/null; then
    if python - "$build_path" "$SOURCE_SHA" <<'PY'
import json
import sys
from pathlib import Path
try:
    payload = json.loads(Path(sys.argv[1]).read_text())
except (json.JSONDecodeError, UnicodeDecodeError):
    raise SystemExit(1)
raise SystemExit(0 if payload.get('sourceSha') == sys.argv[2] and payload.get('release') == 'native-sharing-live-synthetic-v1' else 1)
PY
    then
      asset_ready=1
      break
    fi
  fi
  sleep 2
done
test "$asset_ready" = '1'
echo 'BUILD_JSON_ASSET_ATTESTATION=PASS'

STRACKER_QA_URL="$TARGET_URL" \
STRACKER_EXPECTED_SHA="$SOURCE_SHA" \
STRACKER_EXPECTED_VERSION_ID="$PUBLIC_VERSION_ID" \
STRACKER_VERSION_OVERRIDE="$PUBLIC_VERSION_ID" \
STRACKER_API_QA_OUTPUT="$API_QA_OUTPUT" \
bun scripts/release/live-native-sharing-api-qa.ts
echo 'ZERO_PERCENT_OVERRIDE_API_E2E=PASS'

STRACKER_QA_URL="$TARGET_URL" \
STRACKER_EXPECTED_SHA="$SOURCE_SHA" \
STRACKER_EXPECTED_VERSION_ID="$PUBLIC_VERSION_ID" \
STRACKER_VERSION_OVERRIDE="$PUBLIC_VERSION_ID" \
STRACKER_BROWSER_QA_OUTPUT="$BROWSER_QA_OUTPUT" \
CHROME_BIN="${CHROME_BIN:-/usr/bin/google-chrome}" \
bun scripts/release/live-native-sharing-browser-qa.ts
echo 'ZERO_PERCENT_OVERRIDE_BROWSER_E2E=PASS'

run_wrangler "$STATE_DIR/public-promote.log" versions deploy \
  "${PUBLIC_VERSION_ID}@100%" \
  --name "$PUBLIC_WORKER" \
  --message "STRACKER native-sharing-live ${SOURCE_SHA}" \
  -y

post_promotion_ok=0
for _ in {1..24}; do
  if STRACKER_QA_URL="$TARGET_URL" \
     STRACKER_EXPECTED_SHA="$SOURCE_SHA" \
     STRACKER_EXPECTED_VERSION_ID="$PUBLIC_VERSION_ID" \
     STRACKER_API_QA_OUTPUT="$API_QA_OUTPUT" \
     bun scripts/release/live-native-sharing-api-qa.ts >/dev/null 2>&1 && \
     STRACKER_QA_URL="$TARGET_URL" \
     STRACKER_EXPECTED_SHA="$SOURCE_SHA" \
     STRACKER_EXPECTED_VERSION_ID="$PUBLIC_VERSION_ID" \
     STRACKER_BROWSER_QA_OUTPUT="$BROWSER_QA_OUTPUT" \
     CHROME_BIN="${CHROME_BIN:-/usr/bin/google-chrome}" \
     bun scripts/release/live-native-sharing-browser-qa.ts >/dev/null 2>&1; then
    post_promotion_ok=1
    break
  fi
  sleep 5
done
test "$post_promotion_ok" = '1'
echo 'PUBLIC_POST_PROMOTION_QA=PASS'

api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${PUBLIC_WORKER}/deployments" "$STATE_DIR/public-deployments-final.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${PUBLIC_WORKER}/settings" "$STATE_DIR/public-settings-final.json"
python - "$STATE_DIR" "$PUBLIC_VERSION_ID" <<'PY'
import json
import sys
from pathlib import Path
root, candidate = Path(sys.argv[1]), sys.argv[2]
payload = json.loads((root/'public-deployments-final.json').read_text())['result']
deployments = payload.get('deployments', payload if isinstance(payload, list) else [])
if not deployments:
    raise SystemExit('FINAL_PUBLIC_DEPLOYMENT_UNAVAILABLE')
current = deployments[0]
versions = current.get('versions') or []
match = [item for item in versions if (item.get('version_id') or item.get('id')) == candidate]
if len(match) != 1 or float(match[0].get('percentage', -1)) != 100:
    raise SystemExit('FINAL_PUBLIC_VERSION_MISMATCH')
(root/'public-final-deployment-id.txt').write_text(str(current.get('id') or 'unknown')+'\n')
settings = json.loads((root/'public-settings-final.json').read_text()).get('result') or {}
bindings = settings.get('bindings') or []
def name(binding):
    return binding.get('name') or binding.get('binding') or ''
services = [item for item in bindings if item.get('type') == 'service']
if len(services) != 1 or name(services[0]) != 'NATIVE_SHARING_BACKEND' or services[0].get('service') != 'stracker-native-sharing-backend':
    raise SystemExit('FINAL_PUBLIC_SERVICE_BINDING_MISMATCH')
print('FINAL_PUBLIC_DEPLOYMENT_100_PERCENT=PASS')
print('FINAL_PUBLIC_SERVICE_BINDING=PASS')
PY

rollback_required=0
trap - ERR

python - "$STATE_DIR" "$SOURCE_SHA" "$TARGET_URL" "$API_QA_OUTPUT" "$BROWSER_QA_OUTPUT" <<'PY'
import hashlib
import json
import sys
from pathlib import Path
root, sha, url, api_path, browser_path = Path(sys.argv[1]), sys.argv[2], sys.argv[3], Path(sys.argv[4]), Path(sys.argv[5])
api = json.loads(api_path.read_text())
browser = json.loads(browser_path.read_text())
def short(path):
    value = path.read_text().strip()
    return value[:8] if value and value != 'unknown' else value
def hashed(path):
    return hashlib.sha256(path.read_text().strip().encode()).hexdigest()
evidence = {
    'schema': 'stracker.native-sharing-live-synthetic.release.v1',
    'sourceSha': sha,
    'targetUrl': url,
    'backendWorkerExists': True,
    'backendPublicIngress': False,
    'backendDurableObjectSqlite': True,
    'backendVersionHash': (root/'backend-version-hash.txt').read_text().strip(),
    'publicPreviousVersionHash': hashed(root/'public-previous-version-id.txt'),
    'publicCandidateVersionHash': hashed(root/'public-candidate-version-id.txt'),
    'zeroPercentDeploymentShort': short(root/'public-zero-deployment-id.txt'),
    'finalDeploymentShort': short(root/'public-final-deployment-id.txt'),
    'versionMetadataMatch': api['gates']['VERSION_METADATA_MATCH'] == 'PASS',
    'buildAssetShaMatch': api['gates']['BUILD_ASSET_SHA_MATCH'] == 'PASS',
    'syntheticApiE2ePass': True,
    'syntheticBrowserE2ePass': True,
    'publicPostPromotionQaPass': True,
    'pageErrorTotal': browser['pageErrorTotal'],
    'relevantConsoleErrors': browser['relevantConsoleErrors'],
    'horizontalOverflowTotal': browser['horizontalOverflowTotal'],
    'privateDataUsed': False,
    'realCoordinatesUsed': False,
    'syntheticCoordinateValuesRetained': False,
    'capabilitiesRetained': False,
    'authorizationValuesRetained': False,
    'secretsExposed': False,
    'destructiveDeletions': False,
    'publicRollbackArmedUntilFinalQa': True,
    'physicalValidation': 'NOT_EXECUTED_ENV_BLOCKED',
    'apiGates': api['gates'],
    'browserGates': browser['gates'],
}
out = root/'release-evidence.json'
out.write_text(json.dumps(evidence, indent=2, sort_keys=True)+'\n')
(root/'release-evidence.sha256').write_text(hashlib.sha256(out.read_bytes()).hexdigest()+'\n')
print('NATIVE_SHARING_LIVE_SYNTHETIC_PASS=YES')
PY

echo "RELEASE_EVIDENCE_DIR=$STATE_DIR" >> "${GITHUB_ENV:-/dev/null}"
echo 'RESULT=NATIVE_SHARING_LIVE_SYNTHETIC_PASS'
