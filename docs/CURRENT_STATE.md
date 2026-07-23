# STRACKER — Current State

## Canonical milestone

```text
ACTIVE_PHASE=NATIVE_SHARING_CLOUDFLARE_RUNTIME_V1_CODE_ONLY
ACTIVE_BRANCH=feat/stracker-native-sharing-cloudflare-runtime-v1
ACTIVE_DRAFT_PR=9
PR_BASE=feat/stracker-native-location-sharing-v1
PR_BASE_SHA=b001814b675fb8c8cf2713ff4728cd250e8a25c8
CURRENT_HEAD_SHA=SEE_DRAFT_PR_9_HEAD
TECHNICAL_GREEN_SHA=591f976c54cda15d052a6a4c276f45be7e7b123d
TECHNICAL_GREEN_RUN_ID=29974238896
TECHNICAL_GREEN_CONCLUSION=success
TECHNICAL_GREEN_ARTIFACT_ID=8550837441
TECHNICAL_GREEN_ARTIFACT_DIGEST=sha256:571bf4f0ff295d0664056b98b42920a9cbce779286cf89947d875e8c72768427
PR_STATE=OPEN_DRAFT
MERGE_EXECUTED=NO
DEPLOYMENT_EXECUTED=NO
PRODUCTION_MODIFIED=NO
PRODUCTION_TRAFFIC=0%
```

PR #9 is stacked directly on the final frozen head of PR #8. It is not based on PR #7 and does not merge or cherry-pick PR #7.

```text
PR_6_ROLE=FROZEN_VECTOR_MAP_ENGINE_BASE
PR_6_HEAD_SHA=8a3ac8d750b107e24f5ce744f15a0bbae9767f1f

PR_7_ROLE=EXPERIMENTAL_GOOGLE_RUNTIME_SPIKE
PR_7_RELEASE_DEPENDENCY=NO
PR_7_PRODUCTION_CANDIDATE=NO

PR_8_ROLE=FROZEN_NATIVE_LOCATION_SHARING_PRODUCT
PR_8_HEAD_SHA=b001814b675fb8c8cf2713ff4728cd250e8a25c8
PR_8_FINAL_RUN_ID=29971797092
PR_8_MERGE=NO
PR_8_DEPLOY=NO
```

## Canonical product

Every open, reload, new tab and navigation to `/` begins at:

```text
¿QUÉ UBICACIÓN QUERÉS VER?
MI UBICACIÓN
UBICACIÓN COMPARTIDA
```

Selection is memory-only. Before choosing a source:

```text
MAP_REQUEST=NO
LOCATION_REQUEST=NO
SESSION_REQUEST=NO
POINTS_REQUEST=NO
```

The canonical source and provider model remains:

```ts
type LocationSource =
  | 'my-device'
  | 'shared-location'

type SharedLocationProvider =
  | 'stracker-native'
  | 'google-session-experimental'
```

Inside `UBICACIÓN COMPARTIDA`:

```text
[ ABRIR ENLACE STRACKER ]
[ COMPARTIR MI UBICACIÓN ]
[ GOOGLE MAPS — EXPERIMENTAL ]
```

The Google option is disabled and displays `No disponible en esta versión`.

```text
GOOGLE_PROVIDER_DISABLED=YES
REAL_GOOGLE_REQUESTS=NO
REAL_GOOGLE_CREDENTIALS=NO
REAL_COOKIES=NO
LEGACY_GOOGLE_SHARED_RUNTIME_REFERENCE=ABSENT
```

## Native viewer boundary

The only supported viewer link is:

```text
/shared#v=<capability>
```

```text
VIEWER_CAPABILITY_IN_PATH=NO
VIEWER_CAPABILITY_IN_QUERY=NO
CAPABILITY_FRAGMENT_ONLY=PASS
```

The initial HTTP request contains neither the fragment nor the capability. Before explicit `VER UBICACIÓN`:

```text
NO_STATUS_REQUEST=PASS
NO_POINTS_REQUEST=PASS
NO_MAP_REQUEST=PASS
NO_CAPABILITY_EXCHANGE=PASS
```

After confirmation:

```text
fragment capability
→ POST /api/share/viewer/exchange
→ short-lived opaque viewer session
→ history.replaceState(null, '', '/shared')
→ original capability cleared
→ Authorization: Bearer polling
```

The opaque viewer token remains only in document memory. Rotation increments viewer generation and invalidates the prior capability and all active viewer sessions from the previous generation. Revocation and expiration reject reads and writes immediately. Late frontend responses are ignored.

The Worker rejects query-bearing `/shared` requests before Static Assets. The shared document is served with:

```text
Cache-Control=no-store, max-age=0
Referrer-Policy=no-referrer
Content-Security-Policy=STRICT
Permissions-Policy=geolocation=(), camera=(), microphone=()
X-Robots-Tag=noindex, nofollow, noarchive, nosnippet
ANALYTICS_ON_SHARED_ROUTES=OFF
```

## Cloudflare runtime architecture

PR #9 implements code only:

```text
Browser
→ stateless Worker gateway
→ Native Sharing API
→ one NativeSharingDurableObject per SESSION_ID
→ private SQLite database attached to that object
→ Static Assets
```

Deterministic routing uses:

```ts
env.NATIVE_SHARING.getByName(sessionId)
```

Each `SESSION_ID` maps to one object. No database contains points or capabilities from another sharing session. The Worker carries no mutable request state across sessions.

```text
ONE_SESSION_ONE_OBJECT=PASS
NO_CROSS_SESSION_STATE=PASS
```

## Durable Object responsibilities

`NativeSharingDurableObject` owns:

```text
session metadata
emitter verifier
viewer capability verifier
viewer generation
opaque viewer-session verifiers
latest accepted sequence
bounded confirmed points
server-assigned GhostRail segment indexes
expiry and retention alarm
revocation
viewer rotation
quota state
```

Critical state is persisted in SQLite. The implementation uses `ctx.storage.sql` and a `new_sqlite_classes` migration. It does not use KV-backed Durable Object storage APIs.

```text
DO_SQLITE_ONLY=PASS
KV_BACKED_DO_STORAGE=ABSENT
```

### SQLite tables

```text
sharing_session
points
viewer_sessions
```

`sharing_session` is a single-row record in each object. `points` is keyed by monotonic sequence. `viewer_sessions` stores only token verifiers with generation, expiry and revocation state.

## Worker HTTP API

```text
POST   /api/share/sessions
POST   /api/share/sessions/:id/points
POST   /api/share/viewer/exchange
POST   /api/share/viewer/logout
GET    /api/share/sessions/:id/status
GET    /api/share/sessions/:id/points
POST   /api/share/sessions/:id/rotate-viewer
DELETE /api/share/sessions/:id
```

The Worker validates:

```text
strict path
strict method
same origin
JSON content type
body size
session identifier shape
emitter capability shape
opaque viewer bearer shape
query absence
binding availability
RPC timeout
```

Responses are JSON-only, `no-store`, `nosniff`, no-referrer and sanitized. Unknown bindings, storage failures, quota failures and timeouts fail closed. Capabilities, tokens and coordinates are never logged.

Canonical HTTP envelopes remain compatible with the PR #8 frontend:

```text
session create → CreateSessionResponse
point publish → { status: 'ok', point }
viewer exchange → ViewerExchangeResponse
viewer logout → { status: 'ok' }
revoke → { status: 'ok', state: 'revoked' }
```

## Quota and retention model

```text
MAX_SESSION_DURATION=4h
MAX_POINTS_PER_SESSION=2880
MAX_POINTS_RETURNED=600
MIN_PUBLISH_INTERVAL=5s
MAX_ACTIVE_VIEWER_SESSIONS=16
VIEWER_SESSION_TTL=10m
EXPIRATION_GRACE=60s
DELETE_AFTER_EXPIRATION=24h
MAX_GHOSTRAIL_SEGMENTS=64
MAX_REQUEST_BODY=16KiB
RPC_TIMEOUT=1500ms
```

The product limits are deliberately conservative. Quota exhaustion rejects the new operation and does not silently discard accepted state. Storage-full and unavailable-storage conditions return sanitized fail-closed errors.

## Static Assets and placeholder configuration

`native-sharing-cloudflare/wrangler.jsonc` is non-routable:

```text
workers_dev=false
preview_urls=false
routes=ABSENT
custom_domains=ABSENT
account_id=ABSENT
zone_id=ABSENT
real_secrets=ABSENT
observability.enabled=false
```

Worker-first paths include:

```text
/api/share/*
/shared
/shared/*
```

The configuration contains the structural Durable Object binding and SQLite migration required for code validation, but no live namespace or account resource exists.

CI permits only:

```text
wrangler types
wrangler deploy --dry-run
```

```text
VERSION_UPLOAD_EXECUTED=NO
DEPLOYMENT_EXECUTED=NO
```

## Browser and runtime QA

The Worker + SQLite E2E was executed against the real exported frontend at:

```text
320x568
360x640
375x812
390x844
412x915
```

```text
BROWSER_QA=PASS
WORKER_SQLITE_E2E=PASS
NO_NETWORK_BEFORE_VIEWER_CONFIRMATION=PASS
CAPABILITY_FRAGMENT_ONLY=PASS
CAPABILITY_EXCHANGE_REQUIRED=PASS
OPAQUE_VIEWER_SESSION_POLLING=PASS
CAPABILITY_IN_TRANSPORT_URL=NO
SHARED_QUERY_REJECTED=PASS
REFERRER_POLICY_NO_REFERRER=PASS
SHARED_CSP_STRICT=PASS
PAGEERROR=0
HORIZONTAL_OVERFLOW=0
```

Runtime tests cover:

```text
ONE_SESSION_ONE_OBJECT=PASS
NO_CROSS_SESSION_STATE=PASS
CONCURRENT_POINT_SERIALIZATION=PASS
REPLAY_BLOCKED=PASS
REVOCATION_IMMEDIATE=PASS
ROTATION_INVALIDATES_VIEWERS=PASS
SESSION_EXPIRATION=PASS
VIEWER_SESSION_EXPIRATION=PASS
RETENTION_BOUNDED=PASS
POINT_QUOTA_FAIL_CLOSED=PASS
VIEWER_QUOTA_FAIL_CLOSED=PASS
STORAGE_FAILURE_FAIL_CLOSED=PASS
BINDING_FAILURE_FAIL_CLOSED=PASS
LATE_RPC_TIMEOUT=PASS
```

## Technical-green evidence

```text
TECHNICAL_GREEN_SHA=591f976c54cda15d052a6a4c276f45be7e7b123d
WORKFLOW_RUN_ID=29974238896
WORKFLOW_CONCLUSION=success
ARTIFACT_ID=8550837441
ARTIFACT_DIGEST=sha256:571bf4f0ff295d0664056b98b42920a9cbce779286cf89947d875e8c72768427
```

Artifact contents are exactly:

```text
browser-qa.json
gates.json
manifest.json
sha256sums.txt
```

Independent inspection verified:

```text
ARTIFACT_HEAD_SHA_MATCH=PASS
ARTIFACT_RUN_ID_MATCH=PASS
ZIP_DIGEST_MATCH=PASS
INTERNAL_SHA256SUMS=PASS
PRIVATE_DATA_USED=FALSE
REAL_COORDINATES=ABSENT
COOKIES=ABSENT
TOKENS=ABSENT
CAPABILITIES=ABSENT
AUTHORIZATION_HEADERS=ABSENT
RAW_LOGS=ABSENT
ENV_FILES=ABSENT
SOURCE_ARCHIVE=ABSENT
```

## Validation state

```text
STACKED_BASE_CHECK=PASS
PR_8_FROZEN=PASS
PR_7_NOT_IN_RELEASE_STACK=PASS
FROZEN_INSTALL=PASS
INHERITED_PR_8_REGRESSION=PASS
BUILD=PASS
STATIC_ASSETS=PASS
WRANGLER_TYPES=PASS
ESLINT=PASS
TYPECHECK=PASS
DO_SQLITE_ONLY=PASS
TESTS=PASS
BROWSER_QA=PASS
WORKER_SQLITE_E2E=PASS
WRANGLER_DRY_RUN=PASS
SECURITY_SCAN=PASS
PREPARE_SANITIZED_ARTIFACT=PASS
SECURITY_ARTIFACT_SCAN=PASS
ARTIFACT_CURRENT_HEAD=PASS
FINAL_INTEGRITY=PASS
CI_FINAL=SUCCESS
```

## Zero-cost boundary

```text
RECURRING_INFRASTRUCTURE_COST_USD=0
MAP_PROVIDER_COST_USD=0
PAID_OVERAGE_ALLOWED=NO
AUTOMATIC_UPGRADE_TO_PAID=NO
BILLING_DEPENDENCY=NO
WORKERS_PLAN=FREE_REQUIRED
DURABLE_OBJECT_BACKEND=SQLITE_ONLY
```

This branch creates no billable or live resource. A future live phase must remain on Cloudflare Free and fail closed at STRACKER's own limits. No paid fallback is permitted.

## Production and live-control-plane status

```text
PRODUCTION_RUNTIME=RENDER
PRODUCTION_URL=https://strackerglm.onrender.com/
PRODUCTION_MODIFIED=NO
RENDER_MODIFIED=NO
CLOUDFLARE_LIVE_MODIFIED=NO
WORKER_LIVE_CREATED=NO
DURABLE_OBJECT_NAMESPACE_LIVE_CREATED=NO
ACCESS_APPLICATION_CREATED=NO
GOOGLE_IDP_CREATED=NO
VERSION_UPLOAD_EXECUTED=NO
DEPLOYMENT_EXECUTED=NO
ROUTE_CREATED=NO
DNS_CHANGED=NO
SECRET_CREATED=NO
PRODUCTION_TRAFFIC=0%
ROLLBACK_EXECUTED=NO
```

## Rollback boundary

A future code rollback does not revert SQLite state. Before any live traffic, a rollback plan must verify schema compatibility, preserve revocation/generation state and smoke-test create, publish, exchange, poll, rotate and revoke. If compatibility is uncertain, traffic remains zero and the runtime stays fail closed.

## Open risks

- This branch validates code and synthetic SQLite behavior, not a live Durable Object namespace.
- Cloudflare account bindings, Free-plan enforcement and actual platform quotas remain unverified until a separately authorized non-production infrastructure phase.
- Browser geolocation can be throttled or suspended in the background; STRACKER does not promise closed-browser tracking.
- A recipient can intentionally redistribute a private viewer link; rotation and revocation limit exposure but cannot prevent deliberate copying.
- Public map providers have no STRACKER-controlled SLA.
- Physical Samsung Galaxy A22 validation remains blocked by the environment.
- Production remains on Render.

## Release posture

```text
PR_9_TECHNICALLY_GREEN_SHA=591f976c54cda15d052a6a4c276f45be7e7b123d
PR_9_STATE=OPEN_DRAFT
PR_9_MERGE=NO
PR_9_DEPLOY=NO
NO_MORE_COMMITS=PENDING_FINAL_DOCUMENTATION_RUN
PRODUCTION_DEPLOY=NO
CLOUDFLARE_CUTOVER=NO_GO
```

## Next exact step

After this documentation HEAD passes the same complete pipeline, freeze PR #9. The next action would require explicit authorization to create isolated non-production Cloudflare resources: a Worker, SQLite-backed Durable Object namespace/binding and a Version upload with zero routes and zero traffic. Stop before that boundary.
