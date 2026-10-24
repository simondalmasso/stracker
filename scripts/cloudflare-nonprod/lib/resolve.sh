# Resolve credentials and prepare fail-closed non-production state.
TOKEN_CANDIDATE="${CF_TOKEN_PRIMARY:-${CF_TOKEN_SECONDARY:-${CF_TOKEN_TERTIARY:-}}}"
if [[ -z "$TOKEN_CANDIDATE" ]]; then
  LIVE_BLOCKER='CLOUDFLARE_CREDENTIAL_NOT_AVAILABLE'
  note "EXTERNAL_BLOCKER=${LIVE_BLOCKER}"
  write_inventory
  exit 42
fi
export CLOUDFLARE_API_TOKEN="$TOKEN_CANDIDATE"
echo "::add-mask::${CLOUDFLARE_API_TOKEN}"

cf_request GET '/user/tokens/verify' >/dev/null
note 'CLOUDFLARE_TOKEN_VERIFIED=PASS'

ACCOUNT_CANDIDATE="${CF_ACCOUNT_PRIMARY:-${CF_ACCOUNT_SECONDARY:-${CF_ACCOUNT_TERTIARY:-}}}"
if [[ -n "$ACCOUNT_CANDIDATE" ]]; then
  CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_CANDIDATE"
else
  ACCOUNTS_JSON="$(cf_request GET '/accounts?per_page=50')"
  ACCOUNT_COUNT="$(jq '.result | length' <<<"$ACCOUNTS_JSON")"
  if [[ "$ACCOUNT_COUNT" != 1 ]]; then
    LIVE_BLOCKER='CLOUDFLARE_ACCOUNT_NOT_UNAMBIGUOUS'
    note "EXTERNAL_BLOCKER=${LIVE_BLOCKER}"
    write_inventory
    exit 42
  fi
  CLOUDFLARE_ACCOUNT_ID="$(jq -r '.result[0].id' <<<"$ACCOUNTS_JSON")"
fi
if [[ ! "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-fA-F]{32}$ ]]; then
  LIVE_BLOCKER='CLOUDFLARE_ACCOUNT_ID_INVALID'
  note "EXTERNAL_BLOCKER=${LIVE_BLOCKER}"
  write_inventory
  exit 42
fi
export CLOUDFLARE_ACCOUNT_ID
echo "::add-mask::${CLOUDFLARE_ACCOUNT_ID}"
note 'CLOUDFLARE_ACCOUNT_RESOLVED=PASS'

ORG_JSON="$(cf_request GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/organizations")" || {
  LIVE_BLOCKER='ZERO_TRUST_ORGANIZATION_UNAVAILABLE'
  note "EXTERNAL_BLOCKER=${LIVE_BLOCKER}"
  write_inventory
  exit 42
}
AUTH_DOMAIN="$(jq -r '.result.auth_domain // empty' <<<"$ORG_JSON")"
if [[ ! "$AUTH_DOMAIN" =~ ^[A-Za-z0-9.-]+\.cloudflareaccess\.com$ ]]; then
  LIVE_BLOCKER='ACCESS_TEAM_DOMAIN_UNAVAILABLE'
  note "EXTERNAL_BLOCKER=${LIVE_BLOCKER}"
  write_inventory
  exit 42
fi
ACCESS_TEAM_DOMAIN="https://${AUTH_DOMAIN}"
note 'ACCESS_TEAM_DOMAIN_RESOLVED=PASS'

OPERATOR_EMAIL="${CF_OPERATOR_PRIMARY:-${CF_OPERATOR_SECONDARY:-${CF_OPERATOR_TERTIARY:-}}}"
if [[ -z "$OPERATOR_EMAIL" ]]; then
  MEMBERS_JSON="$(cf_request GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/members?per_page=50")" || {
    LIVE_BLOCKER='ACCESS_OPERATOR_IDENTITY_UNAVAILABLE'
    note "EXTERNAL_BLOCKER=${LIVE_BLOCKER}"
    write_inventory
    exit 42
  }
  mapfile -t MEMBER_EMAILS < <(jq -r '.result[] | select((.status // "accepted") == "accepted") | .user.email // empty' <<<"$MEMBERS_JSON" | sort -u)
  if [[ "${#MEMBER_EMAILS[@]}" != 1 ]]; then
    LIVE_BLOCKER='ACCESS_OPERATOR_IDENTITY_NOT_UNAMBIGUOUS'
    note "EXTERNAL_BLOCKER=${LIVE_BLOCKER}"
    write_inventory
    exit 42
  fi
  OPERATOR_EMAIL="${MEMBER_EMAILS[0]}"
fi
if [[ ! "$OPERATOR_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  LIVE_BLOCKER='ACCESS_OPERATOR_IDENTITY_INVALID'
  note "EXTERNAL_BLOCKER=${LIVE_BLOCKER}"
  write_inventory
  exit 42
fi
echo "::add-mask::${OPERATOR_EMAIL}"
OPERATOR_HASH="$(printf '%s' "$OPERATOR_EMAIL" | sha256sum | cut -d' ' -f1)"
note 'ACCESS_OPERATOR_IDENTITY_RESOLVED=PASS'

WORKERS_SUBDOMAIN_JSON="$(cf_request GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain")"
WORKERS_SUBDOMAIN="$(jq -r '.result.subdomain // empty' <<<"$WORKERS_SUBDOMAIN_JSON")"
if [[ -z "$WORKERS_SUBDOMAIN" ]]; then
  LIVE_BLOCKER='WORKERS_DEV_SUBDOMAIN_UNAVAILABLE'
  note "EXTERNAL_BLOCKER=${LIVE_BLOCKER}"
  write_inventory
  exit 42
fi

PREVIOUS_GATEWAY_VERSION="$(active_version "$GATEWAY_WORKER" || true)"
PREVIOUS_BACKEND_VERSION="$(active_version "$BACKEND_WORKER" || true)"
cf_optional GET "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${GATEWAY_WORKER}/subdomain" >/dev/null 2>&1 || true
note 'PRE_DEPLOY_STATE_RECORDED=PASS'

STAGING_TOKEN="$(openssl rand -base64 48 | tr -d '\n')"
echo "::add-mask::${STAGING_TOKEN}"
SECRET_FILE="$STATE_DIR/staging-secrets.json"
jq -n --arg token "$STAGING_TOKEN" '{STRACKER_SERVICE_TOKEN:$token}' > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"

MUTATION_STARTED=1
ROLLBACK_REQUIRED=1
TAG_PREFIX="nonprod-${SOURCE_SHA:0:12}"
