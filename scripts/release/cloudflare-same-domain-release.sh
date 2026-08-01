#!/usr/bin/env bash
set -euo pipefail

WORKER_NAME='stracker'
ACCOUNT_SUBDOMAIN='simondalmasso44'
TARGET_URL='https://stracker.simondalmasso44.workers.dev/'
CONFIG='native-sharing-cloudflare/wrangler.release.jsonc'
WRANGLER='bunx wrangler@4.111.0'
SOURCE_SHA="${SOURCE_SHA:?SOURCE_SHA is required}"
QA_OUTPUT="${RUNNER_TEMP:-/tmp}/minimum-runtime-live-qa.json"
STATE_DIR="${RUNNER_TEMP:-/tmp}/stracker-same-domain-release"
mkdir -p "$STATE_DIR"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo 'BLOCKER=CLOUDFLARE_SECRET_ENVIRONMENT_UNAVAILABLE'
  exit 1
fi

python - <<'PY'
import json
from pathlib import Path
config = json.loads(Path('native-sharing-cloudflare/wrangler.release.jsonc').read_text())
assert config['name'] == 'stracker'
assert config['workers_dev'] is True
assert config['preview_urls'] is False
assert config.get('routes') == []
assert config['placement']['mode'] == 'smart'
assert config['observability']['logs']['enabled'] is True
assert config['observability']['traces']['enabled'] is True
for forbidden in ('account_id', 'zone_id', 'exports', 'migrations'):
    assert forbidden not in config
assert 'durable_objects' not in config
assert config['main'] == 'src/minimal-worker.ts'
print('RELEASE_CONFIG_INVARIANTS=PASS')
PY

api_get() {
  local path="$1"
  local output="$2"
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H 'Content-Type: application/json' \
    "https://api.cloudflare.com/client/v4${path}" > "$output"
  jq -e '.success == true' "$output" >/dev/null
}

api_get '/user/tokens/verify' "$STATE_DIR/token.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain" "$STATE_DIR/account-subdomain.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/subdomain" "$STATE_DIR/worker-subdomain.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/deployments" "$STATE_DIR/deployments-before.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/settings" "$STATE_DIR/settings-before.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/domains" "$STATE_DIR/domains-before.json"

python - "$STATE_DIR" <<'PY'
import json
import sys
from pathlib import Path
root = Path(sys.argv[1])
subdomain = json.loads((root/'account-subdomain.json').read_text())['result']['subdomain']
if subdomain != 'simondalmasso44':
    raise SystemExit('TARGET_ACCOUNT_SUBDOMAIN_MISMATCH')
worker_subdomain = json.loads((root/'worker-subdomain.json').read_text())['result']
if worker_subdomain.get('enabled') is not True:
    raise SystemExit('WORKERS_DEV_DISABLED')

dep_payload = json.loads((root/'deployments-before.json').read_text())['result']
deployments = dep_payload.get('deployments', dep_payload if isinstance(dep_payload, list) else [])
if not deployments:
    raise SystemExit('CURRENT_DEPLOYMENT_UNAVAILABLE')
current = deployments[0]
versions = current.get('versions') or []
if not versions:
    raise SystemExit('CURRENT_DEPLOYMENT_VERSION_UNAVAILABLE')
specs = []
for item in versions:
    version_id = item.get('version_id') or item.get('id')
    percentage = item.get('percentage')
    if not version_id or percentage is None:
        raise SystemExit('CURRENT_DEPLOYMENT_SHAPE_UNSUPPORTED')
    specs.append(f'{version_id}@{percentage}%')
(root/'rollback-specs.txt').write_text('\n'.join(specs)+'\n')
(root/'rollback-deployment-id.txt').write_text(str(current.get('id') or 'unknown')+'\n')

settings = json.loads((root/'settings-before.json').read_text()).get('result') or {}
bindings = settings.get('bindings') or []
(root/'binding-types.json').write_text(json.dumps(sorted({str(item.get('type','unknown')) for item in bindings})))

domain_payload = json.loads((root/'domains-before.json').read_text()).get('result') or []
if isinstance(domain_payload, dict):
    domain_payload = domain_payload.get('domains') or []
attached = [item for item in domain_payload if item.get('service') == 'stracker' or item.get('worker') == 'stracker']
if attached:
    raise SystemExit('CUSTOM_DOMAIN_ATTACHED_TO_TARGET_WORKER')
print(f'ROLLBACK_READY=PASS active_versions={len(specs)}')
print('TARGET_WORKER_AND_DOMAIN=PASS')
print('CUSTOM_DOMAIN_CHANGE_REQUIRED=NO')
PY

mkdir -p public/__stracker
python - "$SOURCE_SHA" <<'PY'
import json
import sys
from pathlib import Path
Path('public/__stracker/build.json').write_text(json.dumps({
  'sourceSha': sys.argv[1],
  'release': 'same-domain-minimum-usable-v1',
}, sort_keys=True) + '\n')
PY
NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_STRACKER_SHARED_RUNTIME=disabled bun run build:export
rm -f public/__stracker/build.json
rmdir public/__stracker 2>/dev/null || true

test -f out/index.html
test -f out/__stracker/build.json
test -f out/share/index.html
test -f out/shared/index.html

export WRANGLER_OUTPUT_FILE_PATH="$STATE_DIR/wrangler-output.ndjson"
TAG="same-domain-${SOURCE_SHA:0:12}"
$WRANGLER versions upload \
  --config "$CONFIG" \
  --keep-vars \
  --tag "$TAG" \
  --message "STRACKER same-domain minimum usable ${SOURCE_SHA}"

$WRANGLER versions list --name "$WORKER_NAME" --json > "$STATE_DIR/versions-after-upload.json"
python - "$STATE_DIR" "$TAG" <<'PY'
import json
import sys
from pathlib import Path
root, tag = Path(sys.argv[1]), sys.argv[2]
items = json.loads((root/'versions-after-upload.json').read_text())
if isinstance(items, dict):
    items = items.get('versions') or items.get('result') or []
match = None
for item in items:
    annotations = item.get('annotations') or {}
    item_tag = item.get('tag') or annotations.get('workers/tag')
    if item_tag == tag:
        match = item
        break
if not match:
    raise SystemExit('UPLOADED_VERSION_NOT_FOUND')
version_id = match.get('id') or match.get('version_id')
if not version_id:
    raise SystemExit('UPLOADED_VERSION_ID_MISSING')
(root/'uploaded-version-id.txt').write_text(version_id+'\n')
print('VERSION_UPLOAD=PASS')
PY
VERSION_ID="$(cat "$STATE_DIR/uploaded-version-id.txt")"

rollback_required=0
rollback() {
  local exit_code=$?
  if [[ "$rollback_required" == '1' ]]; then
    mapfile -t rollback_specs < "$STATE_DIR/rollback-specs.txt"
    $WRANGLER versions deploy "${rollback_specs[@]}" --name "$WORKER_NAME" --message 'Automatic rollback after failed STRACKER candidate' -y || true
    echo 'ROLLBACK_EXECUTED=YES'
  fi
  exit "$exit_code"
}
trap rollback ERR

echo 'PREVIEW_URLS_DISABLED_USING_ZERO_PERCENT_OVERRIDE=YES'
mapfile -t current_specs < "$STATE_DIR/rollback-specs.txt"
if [[ "${#current_specs[@]}" -ne 1 ]]; then
  echo 'BLOCKER=MULTI_VERSION_ROLLBACK_BASE_UNSUPPORTED'
  exit 1
fi
rollback_required=1
$WRANGLER versions deploy "${current_specs[0]}" "${VERSION_ID}@0%" --name "$WORKER_NAME" --message 'STRACKER zero-percent smoke deployment' -y
STRACKER_QA_URL="$TARGET_URL" \
STRACKER_EXPECTED_SHA="$SOURCE_SHA" \
STRACKER_VERSION_OVERRIDE="$VERSION_ID" \
STRACKER_QA_OUTPUT="$QA_OUTPUT" \
CHROME_BIN="${CHROME_BIN:-/usr/bin/google-chrome}" \
bun scripts/release/minimum-runtime-qa.ts
echo 'ZERO_PERCENT_VERSION_OVERRIDE_QA=PASS'

$WRANGLER versions deploy "${VERSION_ID}@100%" --name "$WORKER_NAME" --message "STRACKER minimum usable ${SOURCE_SHA}" -y

public_ok=0
for _ in {1..24}; do
  if STRACKER_QA_URL="$TARGET_URL" \
     STRACKER_EXPECTED_SHA="$SOURCE_SHA" \
     STRACKER_QA_OUTPUT="$QA_OUTPUT" \
     CHROME_BIN="${CHROME_BIN:-/usr/bin/google-chrome}" \
     bun scripts/release/minimum-runtime-qa.ts; then
    public_ok=1
    break
  fi
  sleep 5
done
if [[ "$public_ok" != '1' ]]; then
  echo 'PUBLIC_RUNTIME_QA=FAIL'
  exit 1
fi

api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}/deployments" "$STATE_DIR/deployments-after.json"
python - "$STATE_DIR" "$VERSION_ID" <<'PY'
import json
import sys
from pathlib import Path
root, expected = Path(sys.argv[1]), sys.argv[2]
payload = json.loads((root/'deployments-after.json').read_text())['result']
deployments = payload.get('deployments', payload if isinstance(payload, list) else [])
if not deployments:
    raise SystemExit('FINAL_DEPLOYMENT_UNAVAILABLE')
current = deployments[0]
versions = current.get('versions') or []
matched = [item for item in versions if (item.get('version_id') or item.get('id')) == expected]
if len(matched) != 1 or float(matched[0].get('percentage', -1)) != 100:
    raise SystemExit('FINAL_DEPLOYMENT_VERSION_MISMATCH')
(root/'final-deployment-id.txt').write_text(str(current.get('id') or 'unknown')+'\n')
print('FINAL_DEPLOYMENT_100_PERCENT=PASS')
PY

rollback_required=0
trap - ERR

python - "$STATE_DIR" "$SOURCE_SHA" "$TARGET_URL" "$QA_OUTPUT" <<'PY'
import hashlib
import json
import sys
from pathlib import Path
root, sha, url, qa_path = Path(sys.argv[1]), sys.argv[2], sys.argv[3], Path(sys.argv[4])
qa = json.loads(qa_path.read_text())
def short(value):
    value=value.strip()
    return value[:8] if value and value != 'unknown' else value
payload = {
  'schema': 'stracker.same-domain-release-evidence.v1',
  'sourceSha': sha,
  'targetUrl': url,
  'uploadedVersionShort': short((root/'uploaded-version-id.txt').read_text()),
  'deploymentShort': short((root/'final-deployment-id.txt').read_text()),
  'rollbackDeploymentShort': short((root/'rollback-deployment-id.txt').read_text()),
  'privateDataUsed': False,
  'realCoordinatesUsed': False,
  'secretsExposed': False,
  'workerDeleted': False,
  'durableObjectDataDeleted': False,
  'bindingsDeletedDestructively': False,
  'runtimeShaMatch': qa['gates']['RUNTIME_SHA_MATCH'] == 'PASS',
  'pageErrorTotal': qa['pageErrorTotal'],
  'horizontalOverflowTotal': qa['horizontalOverflowTotal'],
  'physicalGeolocationValidation': qa['physicalGeolocationValidation'],
  'gates': qa['gates'],
}
out = root/'release-evidence.json'
out.write_text(json.dumps(payload, indent=2, sort_keys=True)+'\n')
(root/'release-evidence.sha256').write_text(hashlib.sha256(out.read_bytes()).hexdigest()+'\n')
print('SAME_DOMAIN_MINIMUM_USABLE_PASS=YES')
PY

echo "RELEASE_EVIDENCE_DIR=$STATE_DIR" >> "${GITHUB_ENV:-/dev/null}"
echo 'RESULT=SAME_DOMAIN_MINIMUM_USABLE_PASS'
