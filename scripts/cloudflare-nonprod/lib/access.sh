APP_PAYLOAD="$(jq -n --arg name "$ACCESS_APP_NAME" --arg worker "$GATEWAY_WORKER" '{name:$name,type:"self_hosted",session_duration:"4h",app_launcher_visible:false,destinations:[{type:"worker",worker_id:$worker}]}')"
APPS_JSON="$(cf_request GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps?per_page=100")"
APP_MATCHES="$(jq --arg name "$ACCESS_APP_NAME" '[.result[] | select(.name == $name)] | length' <<<"$APPS_JSON")"
if [[ "$APP_MATCHES" -gt 1 ]]; then
  printf 'Multiple staging Access applications have the same name.\n' >&2
  exit 1
elif [[ "$APP_MATCHES" == 1 ]]; then
  ACCESS_APP_ID="$(jq -r --arg name "$ACCESS_APP_NAME" '.result[] | select(.name == $name) | .id' <<<"$APPS_JSON")"
  APP_JSON="$(cf_request PUT "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps/${ACCESS_APP_ID}" "$APP_PAYLOAD")"
else
  APP_JSON="$(cf_request POST "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps" "$APP_PAYLOAD")"
  ACCESS_APP_ID="$(jq -r '.result.id // empty' <<<"$APP_JSON")"
fi
[[ -n "$ACCESS_APP_ID" ]] || { printf 'Access application ID missing.\n' >&2; exit 1; }

POLICIES_JSON="$(cf_request GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps/${ACCESS_APP_ID}/policies")"
while IFS= read -r policy_id; do
  [[ -n "$policy_id" ]] && cf_request DELETE "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps/${ACCESS_APP_ID}/policies/${policy_id}" >/dev/null
done < <(jq -r '.result[]?.id // empty' <<<"$POLICIES_JSON")
POLICY_PAYLOAD="$(jq -n --arg email "$OPERATOR_EMAIL" '{name:"Allow authorized staging operator",decision:"allow",precedence:1,include:[{email:{email:$email}}],exclude:[],require:[]}')"
POLICY_JSON="$(cf_request POST "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps/${ACCESS_APP_ID}/policies" "$POLICY_PAYLOAD")"
ACCESS_POLICY_ID="$(jq -r '.result.id // empty' <<<"$POLICY_JSON")"
[[ -n "$ACCESS_POLICY_ID" ]] || { printf 'Access policy ID missing.\n' >&2; exit 1; }

APP_VERIFY="$(cf_request GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps/${ACCESS_APP_ID}")"
ACCESS_AUD="$(jq -r '.result.aud // empty' <<<"$APP_VERIFY")"
[[ -n "$ACCESS_AUD" ]] || { printf 'Access audience missing.\n' >&2; exit 1; }
jq -e --arg worker "$GATEWAY_WORKER" '.result.destinations | length == 1 and .[0].type == "worker" and .[0].worker_id == $worker' <<<"$APP_VERIFY" >/dev/null
POLICY_VERIFY="$(cf_request GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/apps/${ACCESS_APP_ID}/policies")"
jq -e --arg email "$OPERATOR_EMAIL" '.result | length == 1 and .[0].decision == "allow" and (.[0].include | length == 1) and .[0].include[0].email.email == $email' <<<"$POLICY_VERIFY" >/dev/null
jq -e '[.. | objects | select(has("everyone") or has("any_valid_service_token"))] | length == 0' <<<"$POLICY_VERIFY" >/dev/null
note 'ACCESS_APPLICATION=ACTIVE'
note 'ACCESS_DEFAULT_DENY=PASS'

LIVE_CONFIG='gateway/staging/wrangler.live.jsonc'
ACCESS_TEAM_DOMAIN="$ACCESS_TEAM_DOMAIN" ACCESS_AUD="$ACCESS_AUD" python - <<'PY'
from pathlib import Path
import os
source = Path('gateway/staging/wrangler.template.jsonc').read_text()
source = source.replace('__ACCESS_TEAM_DOMAIN__', os.environ['ACCESS_TEAM_DOMAIN'])
source = source.replace('__ACCESS_AUD__', os.environ['ACCESS_AUD'])
Path('gateway/staging/wrangler.live.jsonc').write_text(source)
PY

GATEWAY_VERSION_ID="$(upload_version "$LIVE_CONFIG" "$GATEWAY_WORKER" "${TAG_PREFIX}-gateway-live")"
for binding in STRACKER_BACKEND ASSETS STRACKER_SERVICE_TOKEN ACCESS_TEAM_DOMAIN ACCESS_AUD; do
  grep -Fq "$binding" "$STATE_DIR/${GATEWAY_WORKER}-version-view.json"
done
GATEWAY_DEPLOYMENT_ID="$(deploy_version "$GATEWAY_WORKER" "$GATEWAY_VERSION_ID")"
rm -f "$LIVE_CONFIG"
note 'GATEWAY_VERSION=CREATED'
note 'GATEWAY_DEPLOYMENT=ACTIVE'

cf_request POST "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${GATEWAY_WORKER}/subdomain" '{"enabled":true,"previews_enabled":false}' >/dev/null
GATEWAY_SUBDOMAIN_STATE="$(cf_request GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${GATEWAY_WORKER}/subdomain")"
jq -e '.result.enabled == true and .result.previews_enabled == false' <<<"$GATEWAY_SUBDOMAIN_STATE" >/dev/null
STAGING_URL="https://${GATEWAY_WORKER}.${WORKERS_SUBDOMAIN}.workers.dev"
note 'STAGING_SURFACE_ENABLED_AFTER_ACCESS=PASS'
