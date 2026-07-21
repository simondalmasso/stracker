# STRACKER — Current State

## Canonical baseline

```text
P0_BASE_SHA=923cac9c9bcc0b7e05701dd1018e61a454d0f478
P0_BRANCH=fix/stracker-p0-security-canonical-state
P0_HEAD_SHA=fa919edad57937481f97e74ac96f09697bf03642
MOBILE_BASE_BRANCH=feat/stracker-mobile-session-product-v1
MOBILE_BASE_SHA=166bf8e316cabd4806ade4fb4c21a20d2ad2040a
CURRENT_BRANCH=feat/stracker-cloudflare-private-gateway-poc
CURRENT_HEAD_SHA=SEE_DRAFT_PR_3_HEAD
PR_BASE=feat/stracker-mobile-session-product-v1
DRAFT_PR=3
PRODUCTION_MODIFIED=NO
DEPLOYMENT_EXECUTED=NO
VERSION_UPLOAD_EXECUTED=NO
PRODUCTION_TRAFFIC=0%
ROLLBACK=NOT_APPLICABLE
```

## Current runtime state

- `CURRENT_RENDER_STATE`: production remains on Render and was not modified.
- `CURRENT_PRODUCTION_STATE`: unchanged; P0, mobile V1 and gateway PoC remain branch-only.
- `CURRENT_UI_SOURCE`: `src/components/mobile/MobileLocationApp.tsx` from frozen PR #2 baseline.
- `CURRENT_STATIC_ARTIFACT`: direct `BUILD_EXPORT=1` Next.js export.
- `CURRENT_BACKEND`: `tracker_map.py`; `nextjs-ui/tracker_map.py` remains byte-identical.
- `AUTH_MODEL`: Cloudflare Access assertion at the edge plus server-only STRACKER service token at the gateway boundary.
- `GATEWAY_MODEL`: exact route/method allowlist, fixed backend service binding, no client-selected upstream, no open proxy and no SSRF path.
- `HEADER_MODEL`: browser headers are discarded; `X-Stracker-Service-Token` is constructed only inside the Worker.
- `CACHE_MODEL`: all gateway and sensitive backend responses are returned with `Cache-Control: no-store` and defensive response headers.
- `LOCATION_SOURCE_MODEL`: strict `my-device | google-shared` contract remains canonical.
- `MY_LOCATION_MODEL`: browser-local `navigator.geolocation.watchPosition()` remains independent from Access and the gateway.
- `SHARED_LOCATION_MODEL`: same-origin requests require `X-Stracker-Gateway: private-poc-v1`; missing Access, Worker or attestation remains fail-closed.
- `COOKIE_MODEL`: no real cookie, session or Google data is used by the PoC or its tests.
- `MOCK_BACKEND_MODEL`: in-memory test binding validates token injection and header stripping.
- `GHOSTRAIL_MODEL`: unchanged from PR #2; no canonical-history migration in this phase.
- `STORAGE_MODEL`: unchanged; Render filesystem persistence remains an open operational risk.

## Cloudflare private gateway PoC implemented

- Manual RS256 Cloudflare Access JWT validation using Web Crypto.
- Exact issuer and audience checks.
- JWKS retrieval restricted to the configured HTTPS Cloudflare Access team origin.
- Exact route and method allowlist:
  - `GET /api/session/status`
  - `POST /api/session/import`
  - `POST /api/session/delete`
  - `GET /points`
- Query strings, unknown routes and unsupported methods rejected.
- Request and response size limits.
- JSON-only protected backend responses.
- Full reconstruction of upstream and downstream headers.
- Server-side service-token injection through the Worker binding.
- Client service-token spoofing overwritten and never forwarded.
- Mock backend E2E with generated Access key pair and synthetic session text only.
- Non-routable Wrangler configuration: no `workers.dev`, preview URL, route, custom domain or traffic.
- No `wrangler deploy`; only an isolated `versions upload --dry-run` build gate.

## Build and validation

```text
PACKAGE_MANAGER=Bun 1.3.4
LOCKFILE=bun.lock
STACKED_BASE_CHECK=SEE_DRAFT_PR_3_CHECKS
BUN_FROZEN_INSTALL=SEE_DRAFT_PR_3_CHECKS
PYTHON_COMPILE=SEE_DRAFT_PR_3_CHECKS
BACKEND_TESTS=SEE_DRAFT_PR_3_CHECKS
TRACKER_DUPLICATE_PARITY=SEE_DRAFT_PR_3_CHECKS
ESLINT=SEE_DRAFT_PR_3_CHECKS
TYPECHECK=SEE_DRAFT_PR_3_CHECKS
STATIC_EXPORT_BUILD=SEE_DRAFT_PR_3_CHECKS
GATEWAY_TESTS=SEE_DRAFT_PR_3_CHECKS
ACCESS_JWT_VALIDATION=SEE_DRAFT_PR_3_CHECKS
OPEN_PROXY=SEE_DRAFT_PR_3_CHECKS
SSRF=SEE_DRAFT_PR_3_CHECKS
SERVICE_TOKEN_IN_BUNDLE=SEE_DRAFT_PR_3_CHECKS
MOCK_E2E=SEE_DRAFT_PR_3_CHECKS
MY_LOCATION_INDEPENDENT=SEE_DRAFT_PR_3_CHECKS
SHARED_LOCATION_FAIL_CLOSED=SEE_DRAFT_PR_3_CHECKS
WRANGLER_DRY_RUN=SEE_DRAFT_PR_3_CHECKS
MOBILE_BROWSER_QA=SEE_DRAFT_PR_3_CHECKS
CI_FINAL=SEE_DRAFT_PR_3_CHECKS
```

The newest `STRACKER Cloudflare Private Gateway PoC` workflow run associated with the current Draft PR #3 head is authoritative.

## Cloudflare resource and deployment state

```text
CLOUDFLARE_ACCESS_APPLICATION=NOT_CREATED
CLOUDFLARE_WORKER=NOT_CREATED_OR_MODIFIED
CLOUDFLARE_VERSION_ID=NONE
CLOUDFLARE_DEPLOYMENT_ID=NONE
CLOUDFLARE_BINDINGS=NOT_PROVISIONED
CLOUDFLARE_SECRETS=NOT_PROVISIONED
CLOUDFLARE_DNS_CHANGED=NO
CLOUDFLARE_ROUTES_CHANGED=NO
CLOUDFLARE_TRAFFIC_CHANGED=NO
RENDER_CHANGED=NO
```

## Known security findings and limitations

- Repository remains public.
- Historical `.env`, private coordinates and sharing material still require separately authorized remediation and potential rotation.
- Production does not enforce P0, mobile V1 or the gateway PoC because no deploy occurred.
- Render filesystem persistence remains unsafe.
- The PoC uses a mock service binding and does not prove browser → real Access app → live Worker → Render.
- A future isolated candidate requires a non-production Access application, non-production service token and isolated backend binding.
- The Google Location Sharing endpoint is undocumented and may change; health parsing must remain fail-closed.
- A code rollback would not automatically revert future KV, D1, R2, Durable Objects or external backend state.

## Release posture

```text
FULL_CLOUDFLARE_CUTOVER=NO_GO
HYBRID_CLOUDFLARE_EDGE_PLUS_RENDER=POC_CODE_READY_PENDING_ISOLATED_INFRA
PR_1_MERGE=NO
PR_2_MERGE=NO
PR_3_MERGE=NO
PRODUCTION_DEPLOY=NO
```

## Next exact step

Review Draft PR #3 and its current-head CI evidence. After explicit authorization for isolated non-production Cloudflare resources, create a dedicated Access application, private Worker candidate and mock backend binding; upload a Version without deployment or traffic, then execute browser-to-preview E2E. Do not connect Render or production secrets in that step.
