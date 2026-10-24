# Validate unauthenticated and authenticated live staging behavior.
unauth_check() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  local prefix="$STATE_DIR/unauth-$(printf '%s' "$method-$path" | tr '/?' '__')"
  local args=(--silent --show-error --request "$method" "${STAGING_URL}${path}" --dump-header "${prefix}.headers" --output "${prefix}.body" --write-out '%{http_code}')
  if [[ -n "$data" ]]; then args+=(--header 'Content-Type: application/json' --data "$data"); fi
  local code
  code="$(curl "${args[@]}")"
  [[ "$code" == 302 || "$code" == 401 || "$code" == 403 ]] || { printf 'Unauthenticated request unexpectedly returned %s for %s %s.\n' "$code" "$method" "$path" >&2; return 1; }
  ! grep -qi '^x-stracker-gateway:' "${prefix}.headers"
}
unauth_check GET '/'
unauth_check GET '/points'
unauth_check POST '/api/session/import' '{"raw":"MOCK_SESSION_ONLY"}'
note 'UNAUTHENTICATED_BLOCKED=PASS'

ACCESS_COOKIE="${CF_ACCESS_COOKIE_PRIMARY:-${CF_ACCESS_COOKIE_SECONDARY:-${CF_ACCESS_COOKIE_TERTIARY:-}}}"
if [[ -z "$ACCESS_COOKIE" ]]; then
  LIVE_BLOCKER='AUTHENTICATED_ACCESS_SESSION_UNAVAILABLE'
  ROLLBACK_REQUIRED=0
  note "EXTERNAL_BLOCKER=${LIVE_BLOCKER}"
  note 'STAGING_LEFT_ACTIVE=ACCESS_PROTECTED_DEFAULT_DENY'
  write_inventory
  rm -f "$SECRET_FILE"
  exit 43
fi
ACCESS_COOKIE="${ACCESS_COOKIE#CF_Authorization=}"
echo "::add-mask::${ACCESS_COOKIE}"

AUTH_HEADERS="$STATE_DIR/auth-root.headers"
AUTH_BODY="$STATE_DIR/auth-root.body"
AUTH_CODE="$(curl --silent --show-error --request GET "$STAGING_URL/" --header "Cookie: CF_Authorization=${ACCESS_COOKIE}" --dump-header "$AUTH_HEADERS" --output "$AUTH_BODY" --write-out '%{http_code}')"
if [[ "$AUTH_CODE" != 200 ]]; then
  if ! grep -qi '^x-stracker-gateway:' "$AUTH_HEADERS"; then
    LIVE_BLOCKER='AUTHENTICATED_ACCESS_SESSION_INVALID_OR_EXPIRED'
    ROLLBACK_REQUIRED=0
    note "EXTERNAL_BLOCKER=${LIVE_BLOCKER}"
    write_inventory
    rm -f "$SECRET_FILE"
    exit 43
  fi
  printf 'Access passed the request but gateway JWT validation failed.\n' >&2
  exit 1
fi
grep -qi '^x-stracker-gateway: private-poc-v1' "$AUTH_HEADERS"
grep -q 'STAGING SINTÉTICO' "$AUTH_BODY"
note 'AUTHENTICATED_HTTP_ROOT=PASS'

api_call() {
  local method="$1"
  local path="$2"
  local scenario="${3:-}"
  local data="${4:-}"
  local prefix="$STATE_DIR/auth-$(printf '%s' "$method-$path-$scenario" | tr '/?' '__')"
  local args=(--silent --show-error --request "$method" "${STAGING_URL}${path}" --header "Cookie: CF_Authorization=${ACCESS_COOKIE}" --header 'Accept: application/json' --dump-header "${prefix}.headers" --output "${prefix}.body" --write-out '%{http_code}')
  [[ -n "$scenario" ]] && args+=(--header "X-Stracker-Staging-Scenario: ${scenario}")
  if [[ -n "$data" ]]; then args+=(--header 'Content-Type: application/json' --data "$data"); fi
  local code
  code="$(curl "${args[@]}")"
  printf '%s\n%s\n%s' "$code" "${prefix}.headers" "${prefix}.body"
}

mapfile -t STATUS_RESULT < <(api_call GET '/api/session/status')
[[ "${STATUS_RESULT[0]}" == 200 ]]
grep -qi '^x-stracker-gateway: private-poc-v1' "${STATUS_RESULT[1]}"
jq -e '.synthetic == true and .dataset == "STRACKER_STAGING_SYNTHETIC_V1" and .securityProof.serviceTokenReceived == true and .securityProof.authorizationReceived == false and .securityProof.cookieReceived == false and .securityProof.accessJwtReceived == false and .securityProof.forwardingHeadersReceived == false and .securityProof.publicIngress == false' "${STATUS_RESULT[2]}" >/dev/null
! grep -Fq "$STAGING_TOKEN" "${STATUS_RESULT[2]}"

mapfile -t IMPORT_RESULT < <(api_call POST '/api/session/import' '' '{"raw":"MOCK_SESSION_ONLY"}')
[[ "${IMPORT_RESULT[0]}" == 200 ]]
jq -e '.synthetic == true and .state == "SHARED_READY"' "${IMPORT_RESULT[2]}" >/dev/null

mapfile -t POINTS_RESULT < <(api_call GET '/points' 'location_fresh')
[[ "${POINTS_RESULT[0]}" == 200 ]]
jq -e '.synthetic == true and .points[0].lat == 0 and .points[0].lng == 0 and .points[0].label == "SYNTHETIC_NULL_ISLAND_NOT_REAL"' "${POINTS_RESULT[2]}" >/dev/null
grep -qi '^cache-control: no-store' "${POINTS_RESULT[1]}"
! grep -qi '^set-cookie:' "${POINTS_RESULT[1]}"

mapfile -t REDIRECT_RESULT < <(api_call GET '/points' 'redirect')
[[ "${REDIRECT_RESULT[0]}" == 502 ]]
jq -e '.error == "UPSTREAM_REDIRECT_REJECTED"' "${REDIRECT_RESULT[2]}" >/dev/null

mapfile -t COOKIE_RESULT < <(api_call GET '/points' 'set_cookie')
[[ "${COOKIE_RESULT[0]}" == 200 ]]
! grep -qi '^set-cookie:' "${COOKIE_RESULT[1]}"

CLIENT_TOKEN_PREFIX="$STATE_DIR/client-token"
CLIENT_TOKEN_CODE="$(curl --silent --show-error "$STAGING_URL/api/session/status" --header "Cookie: CF_Authorization=${ACCESS_COOKIE}" --header 'X-Stracker-Service-Token: CLIENT_VALUE_MUST_BE_DISCARDED' --dump-header "${CLIENT_TOKEN_PREFIX}.headers" --output "${CLIENT_TOKEN_PREFIX}.body" --write-out '%{http_code}')"
[[ "$CLIENT_TOKEN_CODE" == 200 ]]
jq -e '.securityProof.serviceTokenReceived == true' "${CLIENT_TOKEN_PREFIX}.body" >/dev/null

for spec in 'GET|/points?url=https://169.254.169.254|400|QUERY_NOT_ALLOWED' 'GET|/unknown|404|ROUTE_NOT_ALLOWED' 'POST|/points|405|METHOD_NOT_ALLOWED'; do
  IFS='|' read -r method path expected error <<<"$spec"
  prefix="$STATE_DIR/security-$(printf '%s' "$method-$path" | tr '/?:.' '____')"
  code="$(curl --silent --show-error --request "$method" "${STAGING_URL}${path}" --header "Cookie: CF_Authorization=${ACCESS_COOKIE}" --dump-header "${prefix}.headers" --output "${prefix}.body" --write-out '%{http_code}')"
  [[ "$code" == "$expected" ]]
  jq -e --arg error "$error" '.error == $error' "${prefix}.body" >/dev/null
done
note 'SERVICE_BINDING_LIVE=PASS'
note 'OPEN_PROXY=NO'
note 'SSRF=BLOCKED'
note 'UNKNOWN_ROUTE=BLOCKED'
note 'UNKNOWN_METHOD=BLOCKED'
note 'QUERY_STRING=BLOCKED'
note 'CLIENT_SERVICE_TOKEN=DISCARDED'
note 'REDIRECT=BLOCKED'
note 'SET_COOKIE=STRIPPED'
note 'CACHE_CONTROL=NO_STORE'
note 'SERVICE_TOKEN_IN_RESPONSE=NO'
note 'COOKIE_VALUES=ABSENT'
note 'REAL_LOCATION_DATA=ABSENT'

QA_BASE_URL="$STAGING_URL" CLOUDFLARE_ACCESS_AUTH_COOKIE="$ACCESS_COOKIE" node tests/mobile_live_qa.mjs | tee -a "$SUMMARY"
note 'AUTHENTICATED_BROWSER=PASS'
note 'MOBILE_LIVE_QA=PASS'
note 'PRODUCTION_TRAFFIC=0'
note 'NONPROD_LIVE_FINAL=SUCCESS'

ROLLBACK_REQUIRED=0
write_inventory
rm -f "$SECRET_FILE"
