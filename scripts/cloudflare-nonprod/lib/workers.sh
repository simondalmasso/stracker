BACKEND_VERSION_ID="$(upload_version 'gateway/mock-backend/wrangler.jsonc' "$BACKEND_WORKER" "${TAG_PREFIX}-backend")"
grep -Fq 'STRACKER_SERVICE_TOKEN' "$STATE_DIR/${BACKEND_WORKER}-version-view.json"
BACKEND_DEPLOYMENT_ID="$(deploy_version "$BACKEND_WORKER" "$BACKEND_VERSION_ID")"
cf_request POST "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${BACKEND_WORKER}/subdomain" '{"enabled":false,"previews_enabled":false}' >/dev/null
BACKEND_SUBDOMAIN_STATE="$(cf_request GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${BACKEND_WORKER}/subdomain")"
jq -e '.result.enabled == false and .result.previews_enabled == false' <<<"$BACKEND_SUBDOMAIN_STATE" >/dev/null
note 'MOCK_BACKEND_VERSION=CREATED'
note 'MOCK_BACKEND_DEPLOYMENT=ACTIVE'
note 'MOCK_BACKEND_PRIVATE=PASS'

BOOTSTRAP_VERSION="$(upload_version 'gateway/staging/wrangler.bootstrap.jsonc' "$GATEWAY_WORKER" "${TAG_PREFIX}-gateway-bootstrap")"
BOOTSTRAP_DEPLOYMENT="$(deploy_version "$GATEWAY_WORKER" "$BOOTSTRAP_VERSION")"
cf_request POST "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${GATEWAY_WORKER}/subdomain" '{"enabled":false,"previews_enabled":false}' >/dev/null
GATEWAY_BOOTSTRAP_STATE="$(cf_request GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${GATEWAY_WORKER}/subdomain")"
jq -e '.result.enabled == false and .result.previews_enabled == false' <<<"$GATEWAY_BOOTSTRAP_STATE" >/dev/null
note 'GATEWAY_BOOTSTRAP_PRIVATE=PASS'
