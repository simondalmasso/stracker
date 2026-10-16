#!/usr/bin/env bash
set -Eeuo pipefail

BACKEND_WORKER='stracker-native-sharing-backend'
BACKEND_CONFIG='native-sharing-cloudflare/wrangler.backend.jsonc'
SOURCE_SHA="${SOURCE_SHA:?SOURCE_SHA required}"
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN required}"
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID required}"
STATE_DIR="${RUNNER_TEMP:-/tmp}/stracker-controlled-physical-pilot-release"
WRANGLER=(bunx wrangler@4.111.0)
mkdir -p "$STATE_DIR"

api_get() {
  curl --fail-with-body --silent --show-error \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H 'Content-Type: application/json' \
    "https://api.cloudflare.com/client/v4$1" > "$2"
  jq -e '.success == true' "$2" >/dev/null
}

run_wrangler() {
  local output="$1"
  shift
  if ! "${WRANGLER[@]}" "$@" >"$output" 2>&1; then
    sed -E -e 's/[0-9a-f]{8}-[0-9a-f-]{27,}/[ID_REDACTED]/gI' -e 's/[A-Za-z0-9_-]{43,}/[VALUE_REDACTED]/g' "$output" | tail -40
    return 1
  fi
}

api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${BACKEND_WORKER}/deployments" "$STATE_DIR/backend-deployments-before-order001.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${BACKEND_WORKER}/settings" "$STATE_DIR/backend-settings-before-order001.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${BACKEND_WORKER}/subdomain" "$STATE_DIR/backend-subdomain-before-order001.json"

python - "$STATE_DIR" <<'PY'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
payload = json.loads((root/'backend-deployments-before-order001.json').read_text())['result']
deployments = payload.get('deployments', payload if isinstance(payload, list) else [])
if not deployments: raise SystemExit('ORDER001_BACKEND_DEPLOYMENT_UNAVAILABLE')
versions = deployments[0].get('versions') or []
live = [item for item in versions if float(item.get('percentage', -1)) == 100]
other = [item for item in versions if float(item.get('percentage', -1)) not in (0, 100)]
if len(live) != 1 or other: raise SystemExit('ORDER001_BACKEND_DEPLOYMENT_SHAPE_UNSUPPORTED')
previous = live[0].get('version_id') or live[0].get('id')
if not previous: raise SystemExit('ORDER001_BACKEND_PREVIOUS_VERSION_UNAVAILABLE')
(root/'backend-previous-version-id.txt').write_text(previous+'\n')
settings = json.loads((root/'backend-settings-before-order001.json').read_text()).get('result') or {}
bindings = settings.get('bindings') or []
secret = any((b.get('name') or b.get('binding')) == 'COOKIE_SESSION_ENCRYPTION_KEY' and b.get('type') in ('secret_text','secret') for b in bindings)
(root/'backend-secret-existed-before.txt').write_text(('YES' if secret else 'NO')+'\n')
subdomain = json.loads((root/'backend-subdomain-before-order001.json').read_text()).get('result') or {}
if subdomain.get('enabled') is not False: raise SystemExit('ORDER001_BACKEND_PUBLIC_INGRESS_ENABLED')
print('ORDER001_BACKEND_PREVIOUS_VERSION_CAPTURED=PASS')
print('ORDER001_BACKEND_PUBLIC_INGRESS_BEFORE=FALSE')
PY

if [[ "$(cat "$STATE_DIR/backend-secret-existed-before.txt")" == 'NO' ]]; then
  # The secret value is generated in-process, piped directly to Wrangler, and never written or echoed.
  if ! python - <<'PY' | "${WRANGLER[@]}" secret put COOKIE_SESSION_ENCRYPTION_KEY --name "$BACKEND_WORKER" --config "$BACKEND_CONFIG" >"$STATE_DIR/backend-secret-put.log" 2>&1
import secrets
print(secrets.token_urlsafe(48))
PY
  then
    sed -E -e 's/[A-Za-z0-9_-]{43,}/[VALUE_REDACTED]/g' "$STATE_DIR/backend-secret-put.log" | tail -30
    exit 1
  fi
  echo 'ORDER001_BACKEND_SECRET_CREATED=YES'
else
  echo 'ORDER001_BACKEND_SECRET_CREATED=NO'
fi

TAG="order001-backend-${SOURCE_SHA}"
run_wrangler "$STATE_DIR/backend-upload.log" versions upload --config "$BACKEND_CONFIG" --keep-vars --tag "$TAG" --message "STRACKER ORDER-001 backend ${SOURCE_SHA}"
run_wrangler "$STATE_DIR/backend-versions.json" versions list --name "$BACKEND_WORKER" --json
python - "$STATE_DIR" "$TAG" <<'PY'
import json, sys
from pathlib import Path
root, tag = Path(sys.argv[1]), sys.argv[2]
items = json.loads((root/'backend-versions.json').read_text())
if isinstance(items, dict): items = items.get('versions') or items.get('result') or []
for item in items:
    annotations = item.get('annotations') or item.get('metadata', {}).get('annotations') or {}
    if (item.get('tag') or annotations.get('workers/tag')) == tag:
        version = item.get('id') or item.get('version_id')
        if version:
            (root/'backend-candidate-version-id.txt').write_text(version+'\n')
            print('ORDER001_BACKEND_EXACT_HEAD_UPLOAD=PASS')
            break
else: raise SystemExit('ORDER001_BACKEND_CANDIDATE_VERSION_NOT_FOUND')
PY
BACKEND_CANDIDATE_VERSION="$(cat "$STATE_DIR/backend-candidate-version-id.txt")"
run_wrangler "$STATE_DIR/backend-deploy.log" versions deploy "${BACKEND_CANDIDATE_VERSION}@100%" --name "$BACKEND_WORKER" --message "STRACKER ORDER-001 backend exact-head ${SOURCE_SHA}" -y

api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${BACKEND_WORKER}/deployments" "$STATE_DIR/backend-deployments-after-order001.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${BACKEND_WORKER}/settings" "$STATE_DIR/backend-settings-after-order001.json"
api_get "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${BACKEND_WORKER}/subdomain" "$STATE_DIR/backend-subdomain-after-order001.json"
python - "$STATE_DIR" "$BACKEND_CANDIDATE_VERSION" "$SOURCE_SHA" <<'PY'
import hashlib, json, sys
from pathlib import Path
root, candidate, source_sha = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
payload = json.loads((root/'backend-deployments-after-order001.json').read_text())['result']
deployments = payload.get('deployments', payload if isinstance(payload, list) else [])
if not deployments: raise SystemExit('ORDER001_BACKEND_POST_DEPLOYMENT_UNAVAILABLE')
versions = deployments[0].get('versions') or []
match = [item for item in versions if (item.get('version_id') or item.get('id')) == candidate]
if len(match) != 1 or float(match[0].get('percentage', -1)) != 100: raise SystemExit('ORDER001_BACKEND_EXACT_HEAD_NOT_100_PERCENT')
settings = json.loads((root/'backend-settings-after-order001.json').read_text()).get('result') or {}
bindings = settings.get('bindings') or []
if not any((b.get('name') or b.get('binding')) == 'COOKIE_SESSION_ENCRYPTION_KEY' and b.get('type') in ('secret_text','secret') for b in bindings):
    raise SystemExit('ORDER001_BACKEND_ENCRYPTION_SECRET_BINDING_MISSING')
subdomain = json.loads((root/'backend-subdomain-after-order001.json').read_text()).get('result') or {}
if subdomain.get('enabled') is not False: raise SystemExit('ORDER001_BACKEND_PUBLIC_INGRESS_AFTER_ENABLED')
(root/'backend-candidate-version.sha256').write_text(hashlib.sha256(candidate.encode()).hexdigest()+'\n')
(root/'backend-source-sha.txt').write_text(source_sha+'\n')
print('ORDER001_BACKEND_EXACT_HEAD_DEPLOY=PASS')
print('ORDER001_BACKEND_ENCRYPTION_SECRET_BINDING=PASS')
print('ORDER001_BACKEND_PUBLIC_INGRESS_AFTER=FALSE')
print('ORDER001_BACKEND_RAW_SECRET_RETAINED=NO')
PY
