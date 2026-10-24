# Common state and Cloudflare/Wrangler helpers for non-production staging.
WRANGLER_VERSION="4.112.0"
BACKEND_WORKER="stracker-backend-mock-staging"
GATEWAY_WORKER="stracker-gateway-staging"
ACCESS_APP_NAME="STRACKER Gateway Staging"
COMPATIBILITY_DATE="2026-07-21"
SOURCE_SHA="${GITHUB_SHA:-UNKNOWN}"
STATE_DIR="${RUNNER_TEMP:-/tmp}/stracker-nonprod-live"
EVIDENCE_DIR="$STATE_DIR/evidence"
INVENTORY="$EVIDENCE_DIR/resource-inventory.json"
SUMMARY="$EVIDENCE_DIR/live-validation.txt"
mkdir -p "$EVIDENCE_DIR"
: > "$SUMMARY"

MUTATION_STARTED=0
ROLLBACK_REQUIRED=0
PREVIOUS_GATEWAY_VERSION=""
PREVIOUS_BACKEND_VERSION=""
GATEWAY_VERSION_ID=""
GATEWAY_DEPLOYMENT_ID=""
BACKEND_VERSION_ID=""
BACKEND_DEPLOYMENT_ID=""
ACCESS_APP_ID=""
ACCESS_POLICY_ID=""
ACCESS_AUD=""
ACCESS_TEAM_DOMAIN=""
STAGING_URL=""
OPERATOR_HASH=""
LIVE_BLOCKER=""

note() {
  printf '%s\n' "$*" | tee -a "$SUMMARY"
}

write_inventory() {
  jq -n \
    --arg source_sha "$SOURCE_SHA" \
    --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg backend_worker "$BACKEND_WORKER" \
    --arg backend_version "$BACKEND_VERSION_ID" \
    --arg backend_deployment "$BACKEND_DEPLOYMENT_ID" \
    --arg gateway_worker "$GATEWAY_WORKER" \
    --arg gateway_version "$GATEWAY_VERSION_ID" \
    --arg gateway_deployment "$GATEWAY_DEPLOYMENT_ID" \
    --arg compatibility_date "$COMPATIBILITY_DATE" \
    --arg access_app_id "$ACCESS_APP_ID" \
    --arg access_policy_id "$ACCESS_POLICY_ID" \
    --arg access_aud "$ACCESS_AUD" \
    --arg access_team_domain "$ACCESS_TEAM_DOMAIN" \
    --arg operator_identity_sha256 "$OPERATOR_HASH" \
    --arg staging_url "$STAGING_URL" \
    --arg blocker "$LIVE_BLOCKER" \
    '{
      source_sha: $source_sha,
      generated_at: $generated_at,
      production_traffic_percent: 0,
      render_modified: false,
      dns_modified: false,
      service_binding: "WORKER_TO_WORKER_ONLY",
      render_integration: "NOT_PART_OF_THIS_PHASE",
      workers: [
        {
          name: $backend_worker,
          version_id: (if $backend_version == "" then null else $backend_version end),
          deployment_id: (if $backend_deployment == "" then null else $backend_deployment end),
          compatibility_date: $compatibility_date,
          bindings_names_only: ["STRACKER_SERVICE_TOKEN"],
          routes: [],
          workers_dev: false,
          preview_urls: false,
          access: "internal-service-binding-only"
        },
        {
          name: $gateway_worker,
          version_id: (if $gateway_version == "" then null else $gateway_version end),
          deployment_id: (if $gateway_deployment == "" then null else $gateway_deployment end),
          compatibility_date: $compatibility_date,
          bindings_names_only: ["ASSETS", "STRACKER_BACKEND", "STRACKER_SERVICE_TOKEN", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD"],
          routes: [],
          workers_dev: ($staging_url | length > 0),
          preview_urls: false,
          access: (if $access_app_id == "" then "not-created" else "default-deny-exact-operator" end)
        }
      ],
      access: {
        application_id: (if $access_app_id == "" then null else $access_app_id end),
        policy_id: (if $access_policy_id == "" then null else $access_policy_id end),
        audience: (if $access_aud == "" then null else $access_aud end),
        team_domain: (if $access_team_domain == "" then null else $access_team_domain end),
        operator_identity_sha256: (if $operator_identity_sha256 == "" then null else $operator_identity_sha256 end)
      },
      staging_url: (if $staging_url == "" then null else $staging_url end),
      external_blocker: (if $blocker == "" then null else $blocker end)
    }' > "$INVENTORY"
}

cf_request() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  local body="$STATE_DIR/cf-response-$(date +%s%N).json"
  local status
  local args=(--silent --show-error --request "$method" "https://api.cloudflare.com/client/v4${path}" --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" --header 'Content-Type: application/json' --output "$body" --write-out '%{http_code}')
  if [[ -n "$data" ]]; then args+=(--data "$data"); fi
  status="$(curl "${args[@]}")"
  if [[ "$status" -lt 200 || "$status" -ge 300 ]] || ! jq -e '.success == true' "$body" >/dev/null 2>&1; then
    local codes
    codes="$(jq -r '[.errors[]?.code] | map(tostring) | join(",")' "$body" 2>/dev/null || true)"
    printf 'Cloudflare API request failed: method=%s path=%s http=%s error_codes=%s\n' "$method" "$path" "$status" "${codes:-unknown}" >&2
    return 1
  fi
  cat "$body"
}

cf_optional() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  local body="$STATE_DIR/cf-optional-$(date +%s%N).json"
  local status
  local args=(--silent --show-error --request "$method" "https://api.cloudflare.com/client/v4${path}" --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" --header 'Content-Type: application/json' --output "$body" --write-out '%{http_code}')
  if [[ -n "$data" ]]; then args+=(--data "$data"); fi
  status="$(curl "${args[@]}")"
  printf '%s\n' "$status" > "${body}.status"
  cat "$body"
}

wrangler() {
  npx --yes "wrangler@${WRANGLER_VERSION}" "$@"
}

active_version() {
  local name="$1"
  local json="$STATE_DIR/${name}-previous-status.json"
  if wrangler deployments status --name "$name" --json > "$json" 2>/dev/null; then
    jq -r '.. | objects | .version_id? // empty' "$json" | head -n1
  fi
}

latest_deployment_id() {
  local name="$1"
  local json="$STATE_DIR/${name}-deployments.json"
  wrangler deployments list --name "$name" --json > "$json"
  jq -r 'if type == "array" then (.[0].id // .[0].deployment_id // empty) else (.id // .deployment_id // empty) end' "$json"
}

upload_version() {
  local config="$1"
  local name="$2"
  local tag="$3"
  local output="$STATE_DIR/${name}-upload.ndjson"
  rm -f "$output"
  WRANGLER_OUTPUT_FILE_PATH="$output" wrangler versions upload \
    --config "$config" \
    --secrets-file "$SECRET_FILE" \
    --tag "$tag" \
    --message "STRACKER nonprod live ${SOURCE_SHA}" \
    > "$STATE_DIR/${name}-upload.log"
  local version_id
  version_id="$(jq -sr '[.[] | select(.type == "version-upload") | .version_id] | map(select(. != null and . != "")) | last // empty' "$output")"
  if [[ -z "$version_id" ]]; then
    printf 'Version upload did not return a Version ID for %s.\n' "$name" >&2
    return 1
  fi
  wrangler versions view "$version_id" --name "$name" --json > "$STATE_DIR/${name}-version-view.json"
  printf '%s' "$version_id"
}

deploy_version() {
  local name="$1"
  local version_id="$2"
  local output="$STATE_DIR/${name}-deploy.ndjson"
  rm -f "$output"
  WRANGLER_OUTPUT_FILE_PATH="$output" wrangler versions deploy "${version_id}@100%" \
    --name "$name" \
    --message "STRACKER staging activation ${SOURCE_SHA}" \
    --yes > "$STATE_DIR/${name}-deploy.log"
  local deployment_id
  deployment_id="$(jq -sr '[.[] | .. | objects | .deployment_id? // empty] | map(select(. != "")) | last // empty' "$output" 2>/dev/null || true)"
  if [[ -z "$deployment_id" ]]; then deployment_id="$(latest_deployment_id "$name")"; fi
  if [[ -z "$deployment_id" ]]; then
    printf 'Deployment did not return a Deployment ID for %s.\n' "$name" >&2
    return 1
  fi
  local status_json="$STATE_DIR/${name}-active-status.json"
  local found=0
  for _ in $(seq 1 20); do
    if wrangler deployments status --name "$name" --json > "$status_json" 2>/dev/null && grep -Fq "$version_id" "$status_json"; then
      found=1
      break
    fi
    sleep 3
  done
  [[ "$found" == 1 ]] || { printf 'Version %s is not active for %s.\n' "$version_id" "$name" >&2; return 1; }
  printf '%s' "$deployment_id"
}

disable_gateway_surface() {
  [[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] || return 0
  cf_optional POST "/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${GATEWAY_WORKER}/subdomain" '{"enabled":false,"previews_enabled":false}' >/dev/null 2>&1 || true
}

rollback() {
  local status="$1"
  [[ "$status" == 0 ]] && return 0
  [[ "$MUTATION_STARTED" == 1 && "$ROLLBACK_REQUIRED" == 1 ]] || return 0
  set +e
  note 'STAGING_ROLLBACK=STARTED'
  disable_gateway_surface
  if [[ -n "$PREVIOUS_GATEWAY_VERSION" ]]; then
    wrangler versions deploy "${PREVIOUS_GATEWAY_VERSION}@100%" --name "$GATEWAY_WORKER" --message 'STRACKER staging automatic rollback' --yes >/dev/null 2>&1
  fi
  if [[ -n "$PREVIOUS_BACKEND_VERSION" ]]; then
    wrangler versions deploy "${PREVIOUS_BACKEND_VERSION}@100%" --name "$BACKEND_WORKER" --message 'STRACKER staging automatic rollback' --yes >/dev/null 2>&1
  fi
  note 'STAGING_ROLLBACK=COMPLETED_SURFACE_DISABLED'
  write_inventory || true
}
trap 'rollback $?' EXIT
