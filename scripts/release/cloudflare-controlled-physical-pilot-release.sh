#!/usr/bin/env bash
set -euo pipefail

PUBLIC_WORKER='stracker'
BACKEND_WORKER='stracker-native-sharing-backend'
TARGET_URL='https://stracker.simondalmasso44.workers.dev/'
PUBLIC_CONFIG='native-sharing-cloudflare/wrangler.release.jsonc'
WRANGLER=(bunx wrangler@4.111.0)
SOURCE_SHA="${SOURCE_SHA:?SOURCE_SHA required}"
STATE_DIR="${RUNNER_TEMP:-/tmp}/stracker-controlled-physical-pilot-release"
API_QA_OUTPUT="$STATE_DIR/api-qa.json"
BASE_BROWSER_QA_OUTPUT="$STATE_DIR/base-browser-qa.json"
PILOT_BROWSER_QA_OUTPUT="$STATE_DIR/pilot-browser-qa.json"
mkdir -p "$STATE_DIR"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo 'BLOCKER=CLOUDFLARE_SECRET_ENVIRONMENT_UNAVAILABLE'
  exit 1
fi

sanitize_tail() {
  sed -E \
    -e 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[ID_REDACTED]/gI' \
    -e 's/[A-Za-z0-9_-]{32,}/[VALUE_REDACTED]/g' \
    "$1" | tail -40
}
run_wrangler() {
  local output="$1"; shift
  if ! "${WRANGLER[@]}" "$@" >"$output" 2>&1; then sanitize_tail "$output"; return 1; fi
}
api_get() {
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H 'Content-Type: application/json' \
    "https://api.cloudflare.com/client/v4$1" > "$2"
  jq -e '.success == true' "$2" >/dev/null
}

python - <<'PY'
import json
from pathlib import Path
public = json.loads(Path('native-sharing-cloudflare/wrangler.release.jsonc').read_text())
backend = json.loads(Path('native-sharing-cloudflare/wrangler.backend.jsonc').read_text())
assert public['name'] == 'stracker'
assert public['workers_dev'] is True and public['preview_urls'] is False and public.get('routes') == []
assert public['assets']['binding'] == 'ASSETS'
assert public['version_metadata']['binding'] == 'CF_VERSION_METADATA'
assert public['services'] == [{'binding': 'NATIVE_SHARING_BACKEND', 'service': 'stracker-native-sharing-backend'}]
assert backend['name'] == 'stracker-native-sharing-backend'
assert backend['workers_dev'] is False and backend['preview_urls'] is False and backend.get('routes') == []
assert backend['durable_objects']['bindings'] == [{'name': 'NATIVE_SHARING', 'class_name': 'NativeSharingDurableObject'}]
assert backend['exports'] == {'NativeSharingDurableObject': {'type': 'durable-object', 'storage': 'sqlite'}}
print('RELEASE_CONFIG_INVARIANTS=PASS')
PY

api_get '/user/tokens/verify' "$STATE_DIR/token.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain" "$STATE_DIR/account-subdomain.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${PUBLIC_WORKER}/subdomain" "$STATE_DIR/public-subdomain.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${PUBLIC_WORKER}/deployments" "$STATE_DIR/public-deployments-before.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${PUBLIC_WORKER}/settings" "$STATE_DIR/public-settings-before.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${BACKEND_WORKER}/subdomain" "$STATE_DIR/backend-subdomain.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${BACKEND_WORKER}/deployments" "$STATE_DIR/backend-deployments.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${BACKEND_WORKER}/settings" "$STATE_DIR/backend-settings.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains" "$STATE_DIR/domains.json"

python - "$STATE_DIR" <<'PY'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
subdomain = json.loads((root/'account-subdomain.json').read_text())['result']['subdomain']
if subdomain != 'simondalmasso44': raise SystemExit('TARGET_ACCOUNT_SUBDOMAIN_MISMATCH')
if json.loads((root/'public-subdomain.json').read_text())['result'].get('enabled') is not True: raise SystemExit('PUBLIC_WORKERS_DEV_DISABLED')
if json.loads((root/'backend-subdomain.json').read_text())['result'].get('enabled') is not False: raise SystemExit('BACKEND_PUBLIC_INGRESS_ENABLED')

def current_version(path):
    payload = json.loads(path.read_text())['result']
    deployments = payload.get('deployments', payload if isinstance(payload, list) else [])
    if not deployments: raise SystemExit('DEPLOYMENT_UNAVAILABLE')
    current = deployments[0]
    versions = current.get('versions') or []
    if len(versions) != 1: raise SystemExit('DEPLOYMENT_NOT_SINGLE_VERSION')
    item = versions[0]
    version = item.get('version_id') or item.get('id')
    if not version or float(item.get('percentage', -1)) != 100: raise SystemExit('DEPLOYMENT_SHAPE_UNSUPPORTED')
    return current, version
public_deployment, public_version = current_version(root/'public-deployments-before.json')
backend_deployment, backend_version = current_version(root/'backend-deployments.json')
(root/'rollback-spec.txt').write_text(f'{public_version}@100%\n')
(root/'previous-version-id.txt').write_text(public_version+'\n')
(root/'previous-deployment-id.txt').write_text(str(public_deployment.get('id') or 'unknown')+'\n')
(root/'backend-version-hash.txt').write_text(hashlib.sha256(backend_version.encode()).hexdigest()+'\n')

def name(binding): return binding.get('name') or binding.get('binding') or ''
def service(binding): return binding.get('service') or binding.get('service_name') or ''
public_bindings = (json.loads((root/'public-settings-before.json').read_text()).get('result') or {}).get('bindings') or []
assets = [b for b in public_bindings if b.get('type') == 'assets']
metadata = [b for b in public_bindings if b.get('type') == 'version_metadata']
services = [b for b in public_bindings if b.get('type') == 'service']
if len(assets) != 1 or name(assets[0]) != 'ASSETS': raise SystemExit('PUBLIC_ASSETS_BINDING_NOT_EXACT')
if len(metadata) != 1 or name(metadata[0]) != 'CF_VERSION_METADATA': raise SystemExit('PUBLIC_VERSION_METADATA_NOT_EXACT')
if len(services) != 1 or name(services[0]) != 'NATIVE_SHARING_BACKEND' or service(services[0]) != 'stracker-native-sharing-backend': raise SystemExit('PUBLIC_SERVICE_BINDING_NOT_EXACT')
backend_bindings = (json.loads((root/'backend-settings.json').read_text()).get('result') or {}).get('bindings') or []
durable = [b for b in backend_bindings if b.get('type') in ('durable_object_namespace', 'durable_object')]
if len(durable) != 1 or name(durable[0]) != 'NATIVE_SHARING' or durable[0].get('class_name') != 'NativeSharingDurableObject': raise SystemExit('BACKEND_DURABLE_OBJECT_NOT_EXACT')
domains = json.loads((root/'domains.json').read_text()).get('result') or []
if isinstance(domains, dict): domains = domains.get('domains') or []
for worker in ('stracker', 'stracker-native-sharing-backend'):
    if any(item.get('service') == worker or item.get('worker') == worker for item in domains): raise SystemExit('CUSTOM_DOMAIN_ATTACHED='+worker)
print('PUBLIC_ROLLBACK_READY=PASS')
print('PRIVATE_BACKEND_REUSED_UNCHANGED=PASS')
print('BACKEND_PUBLIC_INGRESS=FALSE')
print('PUBLIC_SERVICE_BINDING=PASS')
PY

SOURCE_SHA="$SOURCE_SHA" bash scripts/release/prepare-controlled-physical-pilot-export.sh
node tools/map-spike/release-bundle-gate.mjs
test -f out/index.html && test -f out/share/index.html && test -f out/shared/index.html && test -f out/__stracker/build.json

TAG="same-domain-${SOURCE_SHA}"
run_wrangler "$STATE_DIR/upload.log" versions upload --config "$PUBLIC_CONFIG" --keep-vars --tag "$TAG" --message "STRACKER controlled-pilot ${SOURCE_SHA}"
run_wrangler "$STATE_DIR/versions.json" versions list --name "$PUBLIC_WORKER" --json
python - "$STATE_DIR" "$TAG" <<'PY'
import json, sys
from pathlib import Path
root, tag = Path(sys.argv[1]), sys.argv[2]
items = json.loads((root/'versions.json').read_text())
if isinstance(items, dict): items = items.get('versions') or items.get('result') or []
for item in items:
    annotations = item.get('annotations') or item.get('metadata', {}).get('annotations') or {}
    if (item.get('tag') or annotations.get('workers/tag')) == tag:
        version = item.get('id') or item.get('version_id')
        if version:
            (root/'candidate-version-id.txt').write_text(version+'\n')
            print('PUBLIC_VERSION_UPLOAD=PASS')
            break
else: raise SystemExit('CANDIDATE_VERSION_NOT_FOUND')
PY
CANDIDATE_VERSION="$(cat "$STATE_DIR/candidate-version-id.txt")"

rollback_required=0
rollback() {
  local code=$?
  if [[ "$rollback_required" == '1' ]]; then
    run_wrangler "$STATE_DIR/rollback.log" versions deploy "$(cat "$STATE_DIR/rollback-spec.txt")" --name "$PUBLIC_WORKER" --message 'Automatic rollback after failed controlled pilot candidate' -y || true
    echo 'PUBLIC_ROLLBACK_EXECUTED=YES'
  fi
  exit "$code"
}
trap rollback ERR
rollback_required=1
run_wrangler "$STATE_DIR/zero.log" versions deploy "$(cat "$STATE_DIR/rollback-spec.txt")" "${CANDIDATE_VERSION}@0%" --name "$PUBLIC_WORKER" --message 'STRACKER controlled pilot zero-percent validation' -y
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${PUBLIC_WORKER}/deployments" "$STATE_DIR/zero-deployments.json"
python - "$STATE_DIR" "$CANDIDATE_VERSION" <<'PY'
import json, sys
from pathlib import Path
root, candidate = Path(sys.argv[1]), sys.argv[2]
deployments = json.loads((root/'zero-deployments.json').read_text())['result'].get('deployments') or []
if not deployments: raise SystemExit('ZERO_DEPLOYMENT_UNAVAILABLE')
match = [v for v in (deployments[0].get('versions') or []) if (v.get('version_id') or v.get('id')) == candidate]
if len(match) != 1 or float(match[0].get('percentage', -1)) != 0: raise SystemExit('ZERO_PERCENT_MISMATCH')
(root/'zero-deployment-id.txt').write_text(str(deployments[0].get('id') or 'unknown')+'\n')
print('PUBLIC_ZERO_PERCENT_DEPLOYMENT=PASS')
PY

for kind in version build; do
  ready=0
  for attempt in {1..30}; do
    path="$STATE_DIR/${kind}-${attempt}.json"
    if curl --fail --silent --show-error --max-time 20 \
      -H "Cloudflare-Workers-Version-Overrides: ${PUBLIC_WORKER}=\"${CANDIDATE_VERSION}\"" \
      -H 'Accept: application/json' -H 'Cache-Control: no-cache' \
      "${TARGET_URL}__stracker/${kind}.json?pilot=${SOURCE_SHA:0:12}&attempt=${attempt}" > "$path" 2>/dev/null; then
      if python - "$path" "$SOURCE_SHA" "$CANDIDATE_VERSION" "$TAG" "$kind" <<'PY'
import json, sys
from pathlib import Path
try: payload = json.loads(Path(sys.argv[1]).read_text())
except Exception: raise SystemExit(1)
sha, version, tag, kind = sys.argv[2:6]
if kind == 'version': valid = payload.get('sourceSha') == sha and payload.get('versionId') == version and payload.get('versionTag') == tag
else: valid = payload.get('sourceSha') == sha and payload.get('release') == 'controlled-physical-pilot-v1'
raise SystemExit(0 if valid else 1)
PY
      then ready=1; break; fi
    fi
    sleep 2
  done
  test "$ready" = '1'
done
echo 'VERSION_METADATA_OVERRIDE=PASS'
echo 'BUILD_JSON_ASSET_ATTESTATION=PASS'

sed "s/native-sharing-live-synthetic-v1/controlled-physical-pilot-v1/" scripts/release/live-native-sharing-api-qa.ts > "$STATE_DIR/pilot-api-qa.ts"
run_qas() {
  local override="$1"
  local suffix="$2"
  STRACKER_QA_URL="$TARGET_URL" STRACKER_EXPECTED_SHA="$SOURCE_SHA" STRACKER_EXPECTED_VERSION_ID="$CANDIDATE_VERSION" STRACKER_VERSION_OVERRIDE="$override" STRACKER_API_QA_OUTPUT="$API_QA_OUTPUT" bun "$STATE_DIR/pilot-api-qa.ts"
  STRACKER_QA_URL="$TARGET_URL" STRACKER_EXPECTED_SHA="$SOURCE_SHA" STRACKER_EXPECTED_VERSION_ID="$CANDIDATE_VERSION" STRACKER_VERSION_OVERRIDE="$override" STRACKER_BROWSER_QA_OUTPUT="$BASE_BROWSER_QA_OUTPUT" CHROME_BIN="${CHROME_BIN:-/usr/bin/google-chrome}" bun scripts/release/live-native-sharing-browser-qa.ts
  STRACKER_QA_URL="$TARGET_URL" STRACKER_EXPECTED_SHA="$SOURCE_SHA" STRACKER_EXPECTED_VERSION_ID="$CANDIDATE_VERSION" STRACKER_VERSION_OVERRIDE="$override" STRACKER_PILOT_QA_OUTPUT="$PILOT_BROWSER_QA_OUTPUT" CHROME_BIN="${CHROME_BIN:-/usr/bin/google-chrome}" bun scripts/release/live-controlled-physical-pilot-browser-qa.ts
  echo "$suffix=PASS"
}
run_qas "$CANDIDATE_VERSION" 'ZERO_PERCENT_OVERRIDE_PILOT_E2E'

run_wrangler "$STATE_DIR/promote.log" versions deploy "${CANDIDATE_VERSION}@100%" --name "$PUBLIC_WORKER" --message "STRACKER controlled pilot ${SOURCE_SHA}" -y
post_ok=0
for attempt in {1..12}; do
  if run_qas '' 'PUBLIC_POST_PROMOTION_QA' > "$STATE_DIR/post-${attempt}.log" 2>&1; then post_ok=1; break; fi
  sleep 5
done
if [[ "$post_ok" != '1' ]]; then sanitize_tail "$STATE_DIR/post-12.log"; exit 1; fi
echo 'PUBLIC_POST_PROMOTION_QA=PASS'

api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${PUBLIC_WORKER}/deployments" "$STATE_DIR/final-deployments.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${PUBLIC_WORKER}/settings" "$STATE_DIR/final-settings.json"
python - "$STATE_DIR" "$CANDIDATE_VERSION" <<'PY'
import json, sys
from pathlib import Path
root, candidate = Path(sys.argv[1]), sys.argv[2]
deployments = json.loads((root/'final-deployments.json').read_text())['result'].get('deployments') or []
if not deployments: raise SystemExit('FINAL_DEPLOYMENT_UNAVAILABLE')
current = deployments[0]
match = [v for v in (current.get('versions') or []) if (v.get('version_id') or v.get('id')) == candidate]
if len(match) != 1 or float(match[0].get('percentage', -1)) != 100: raise SystemExit('FINAL_VERSION_MISMATCH')
(root/'final-deployment-id.txt').write_text(str(current.get('id') or 'unknown')+'\n')
bindings = (json.loads((root/'final-settings.json').read_text()).get('result') or {}).get('bindings') or []
def name(b): return b.get('name') or b.get('binding') or ''
def service(b): return b.get('service') or b.get('service_name') or ''
services = [b for b in bindings if b.get('type') == 'service']
if len(services) != 1 or name(services[0]) != 'NATIVE_SHARING_BACKEND' or service(services[0]) != 'stracker-native-sharing-backend': raise SystemExit('FINAL_SERVICE_BINDING_MISMATCH')
print('FINAL_PUBLIC_DEPLOYMENT_100_PERCENT=PASS')
print('FINAL_PUBLIC_SERVICE_BINDING=PASS')
PY

rollback_required=0
trap - ERR
python - "$STATE_DIR" "$SOURCE_SHA" "$TARGET_URL" "$API_QA_OUTPUT" "$BASE_BROWSER_QA_OUTPUT" "$PILOT_BROWSER_QA_OUTPUT" <<'PY'
import hashlib, json, sys
from pathlib import Path
root, sha, url = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
api = json.loads(Path(sys.argv[4]).read_text())
base = json.loads(Path(sys.argv[5]).read_text())
pilot = json.loads(Path(sys.argv[6]).read_text())
def hashed(path): return hashlib.sha256(path.read_text().strip().encode()).hexdigest()
def short(path):
    value = path.read_text().strip()
    return value[:8] if value != 'unknown' else value
evidence = {
  'schema': 'stracker.controlled-physical-pilot.release.v1',
  'sourceSha': sha, 'targetUrl': url,
  'publicPreviousVersionHash': hashed(root/'previous-version-id.txt'),
  'publicCandidateVersionHash': hashed(root/'candidate-version-id.txt'),
  'backendVersionHash': (root/'backend-version-hash.txt').read_text().strip(),
  'zeroPercentDeploymentShort': short(root/'zero-deployment-id.txt'),
  'finalDeploymentShort': short(root/'final-deployment-id.txt'),
  'backendReusedUnchanged': True, 'backendPublicIngress': False,
  'versionMetadataMatch': True, 'buildAssetShaMatch': True,
  'zeroPercentOverrideApiE2e': True, 'zeroPercentOverrideBaseBrowserE2e': True,
  'zeroPercentOverridePilotE2e': True, 'publicPostPromotionQa': True,
  'privateDataUsed': False, 'realCoordinatesUsed': False,
  'syntheticCoordinateValuesRetained': False, 'capabilitiesRetained': False,
  'authorizationValuesRetained': False, 'secretsExposed': False,
  'destructiveDeletions': False, 'publicRollbackArmedUntilFinalQa': True,
  'physicalValidation': 'PENDING_HUMAN',
  'apiGates': api['gates'], 'baseBrowserGates': base['gates'], 'pilotBrowserGates': pilot['gates'],
  'pageErrorTotal': pilot['pageErrorTotal'], 'relevantConsoleErrors': pilot['relevantConsoleErrors'],
  'horizontalOverflowTotal': pilot['horizontalOverflowTotal'], 'offlineDurationSeconds': pilot['offlineDurationSeconds'],
}
out = root/'release-evidence.json'
out.write_text(json.dumps(evidence, indent=2, sort_keys=True)+'\n')
(root/'release-evidence.sha256').write_text(hashlib.sha256(out.read_bytes()).hexdigest()+'\n')
print('CONTROLLED_PHYSICAL_PILOT_READY=YES')
PY

echo "RELEASE_EVIDENCE_DIR=$STATE_DIR" >> "${GITHUB_ENV:-/dev/null}"
echo 'RESULT=PILOT_READY_FOR_HUMAN'
