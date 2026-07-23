# STRACKER — Current State

## Canonical milestone

```text
ACTIVE_PHASE=NATIVE_LOCATION_SHARING_V1
ACTIVE_BRANCH=feat/stracker-native-location-sharing-v1
ACTIVE_DRAFT_PR=8
PR_BASE=feat/stracker-vector-map-engine-v1
PR_BASE_SHA=8a3ac8d750b107e24f5ce744f15a0bbae9767f1f
CURRENT_HEAD_SHA=SEE_DRAFT_PR_8_HEAD
TECHNICAL_GREEN_SHA=35826d7bdf5a7546cbaf8d9b1795d4210ba6fed5
TECHNICAL_GREEN_RUN_ID=29971586732
TECHNICAL_GREEN_CONCLUSION=success
TECHNICAL_GREEN_ARTIFACT_ID=8549891196
TECHNICAL_GREEN_ARTIFACT_DIGEST=sha256:d58664df8415d872a9b49710860fa7724ac718bfcec324d2587c0c0f9ef237ac
PR_STATE=OPEN_DRAFT
MERGE_EXECUTED=NO
DEPLOYMENT_EXECUTED=NO
PRODUCTION_MODIFIED=NO
PRODUCTION_TRAFFIC=0%
```

PR #8 is stacked directly on the exact frozen head of PR #6. It is not based on PR #7 and does not merge or cherry-pick PR #7.

```text
PR_6_ROLE=FROZEN_VECTOR_MAP_ENGINE_BASE
PR_6_HEAD_SHA=8a3ac8d750b107e24f5ce744f15a0bbae9767f1f
PR_6_MERGE=NO
PR_6_DEPLOY=NO

PR_7_ROLE=EXPERIMENTAL_GOOGLE_RUNTIME_SPIKE
PR_7_RELEASE_DEPENDENCY=NO
PR_7_PRODUCTION_CANDIDATE=NO
PR_7_LIVE_INFRASTRUCTURE=NO
PR_7_MERGE=NO
PR_7_DEPLOY=NO
```

PR #1, PR #2, PR #4, PR #6 and PR #7 remain frozen and unmerged.

## Canonical product entry

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

The canonical source and provider model is:

```ts
type LocationSource =
  | 'my-device'
  | 'shared-location'

type SharedLocationProvider =
  | 'stracker-native'
  | 'google-session-experimental'
```

`google-shared` is absent from executable release code. Provider, motion, freshness, source health, camera, sharing-session state and viewer-session state remain independent.

## Shared-location product

Inside `UBICACIÓN COMPARTIDA`:

```text
[ ABRIR ENLACE STRACKER ]
[ COMPARTIR MI UBICACIÓN ]
[ GOOGLE MAPS — EXPERIMENTAL ]
```

The Google option is disabled and displays `No disponible en esta versión`. The release flow contains no Google cookie importer, Google account dependency, Google Location Sharing request or Google session credential.

```text
GOOGLE_PROVIDER_DISABLED=YES
REAL_GOOGLE_REQUESTS=NO
REAL_COOKIES=NO
```

## Native emitter

Route:

```text
/share
```

`COMPARTIR MI UBICACIÓN` does not request geolocation or create a session before explicit activation.

```text
explicit action
→ geolocation permission
→ session creation
→ independent capabilities
→ watchPosition()
→ bounded point publication
→ private viewer link
```

The UI shows status, remaining duration, last update, stop and revoke controls. It does not promise tracking while the browser is closed or suspended.

Capabilities are independently generated with at least 256 bits of entropy:

```text
SESSION_ID
EMITTER_TOKEN
VIEWER_TOKEN
```

Only verifiers/hashes are stored. The emitter token never enters a URL. Tokens and capabilities are not logged.

## Native viewer security boundary

The only shareable viewer link is:

```text
/shared#v=<capability>
```

```text
VIEWER_CAPABILITY_IN_PATH=NO
VIEWER_CAPABILITY_IN_QUERY=NO
VIEWER_CAPABILITY_FRAGMENT_ONLY=PASS
```

Initial navigation serves only the static confirmation screen. Before `VER UBICACIÓN`:

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
→ authorized status/points polling
```

Polling and logout use:

```http
Authorization: Bearer <opaque-viewer-session>
```

The original capability is sent once in the exchange JSON body and is never reused for polling. The viewer session remains only in document memory and is server-revocable.

Rotation increments viewer generation and invalidates the old capability and every active viewer session from the previous generation. Revocation and expiration stop reads and writes immediately. Late responses are ignored.

Shared routes apply:

```text
Cache-Control=no-store
Referrer-Policy=no-referrer
Content-Security-Policy=STRICT
ANALYTICS_ON_SHARED_ROUTES=OFF
```

## Native HTTP PoC

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

The boundary is JSON-only, `no-store`, strict-method, strict-path, same-origin, body-limited, rate-limited, timeout-bounded and fail-closed. Public errors are sanitized and session identifiers are not enumerable.

## Point validation and retention

```ts
interface NativeSharedLocationPoint {
  version: 1
  sequence: number
  lat: number
  lng: number
  accuracyM: number | null
  speedMps: number | null
  headingDeg: number | null
  capturedAt: string
}
```

The server supplies `receivedAt`, session identity and acceptance state. It independently validates coordinates, age, future timestamps, monotonic sequence, replay, duplicates, frequency, accuracy, speed, impossible jumps and payload size.

Hard limits exist for session duration, points per session, points returned, publish frequency, GhostRail segments, expiration grace and deletion after expiration. Location is not retained indefinitely.

## Storage decision for native sharing

```text
EXECUTABLE_POC_STORE=InMemoryNativeSharingStore
LIVE_CANDIDATE=Durable Objects with SQLite
D1_CANDIDATE=DOCUMENTED_NOT_SELECTED
LIVE_STORAGE_CREATED=NO
```

Durable Objects are the future candidate because one sharing session is the serialization and consistency atom. This decision is specific to native sequential writes, viewer generation, immediate revocation, expiration and concurrent viewers; it is not inherited from PR #7.

No D1 database, Durable Object namespace, migration, binding or live Worker exists in PR #8.

## Renderer and source isolation

PR #8 reuses the PR #6 MapLibre pipeline without duplicating renderer or classifiers:

```text
RENDERER=MapLibre GL JS
BASEMAP_MODES=vector-3d|satellite|hybrid
UI_LABELS=MAPA 3D|SATÉLITE|HÍBRIDO
SECOND_RENDERER=ABSENT
```

```text
VECTOR_STYLE_PROVIDER=OpenFreeMap
BASE_DATA=OpenStreetMap/OpenMapTiles-compatible
SATELLITE_PROVIDER=eox-s2cloudless-2016
SATELLITE_PERIOD=2016-2017 mosaic
SATELLITE_RESOLUTION=10 m
SATELLITE_MAX_ZOOM=14
RECENT_IMAGERY_CLAIM=NO
```

Motion classification, freshness, source health, segmented GhostRail, camera modes, manual mode and late-response protection are preserved. Switching sources clears watcher, polling, abort controllers, timers, marker, GhostRail, buffers, stable coordinate and camera state before entering the new source.

## Zero-cost and live-infrastructure boundary

```text
RECURRING_INFRASTRUCTURE_COST_USD=0
MAP_PROVIDER_COST_USD=0
PAID_OVERAGE_ALLOWED=NO
AUTOMATIC_UPGRADE_TO_PAID=NO
BILLING_DEPENDENCY=NO

WORKER_LIVE_CREATED=NO
DURABLE_OBJECT_LIVE_CREATED=NO
ACCESS_APPLICATION_CREATED=NO
GOOGLE_IDP_CREATED=NO
VERSION_UPLOAD_EXECUTED=NO
DEPLOYMENT_EXECUTED=NO
ROUTE_CREATED=NO
DNS_CHANGED=NO
SECRET_CREATED=NO
```

## Browser QA

The exact technical-green SHA was validated at:

```text
320x568
360x640
375x812
390x844
412x915
```

```text
ROOT_SELECTOR_UNCHANGED=PASS
NO_GEOLOCATION_BEFORE_EMITTER_START=PASS
DYNAMIC_CAPABILITY_ROUTE_ABSENT=PASS
DOCUMENT_REQUEST_PATH=/shared
DOCUMENT_REQUEST_QUERY_PRESENT=FALSE
DOCUMENT_REQUEST_CAPABILITY_PRESENT=FALSE
NO_NETWORK_BEFORE_VIEWER_CONFIRMATION=PASS
NO_API_REQUEST_BEFORE_CONFIRMATION=PASS
NO_MAP_REQUEST_BEFORE_CONFIRMATION=PASS
CAPABILITY_EXCHANGE_REQUIRED=PASS
CAPABILITY_SENT_ONCE=PASS
FRAGMENT_REMOVED_AFTER_EXCHANGE=PASS
ORIGINAL_CAPABILITY_CLEARED_FROM_MEMORY=PASS
CAPABILITY_NOT_REUSED_FOR_POLLING=PASS
POLLING_USES_OPAQUE_VIEWER_SESSION=PASS
VIEWER_SESSION_MEMORY_ONLY=PASS
VIEWER_LOGOUT=PASS
ROTATION_INVALIDATES_ACTIVE_VIEWERS=PASS
REVOCATION_INVALIDATES_ACTIVE_VIEWERS=PASS
SOURCE_ISOLATION=PASS
SOURCE_SWITCH_CLEANUP=PASS
LATE_RESPONSE_BLOCKED=PASS
STALE_NOT_LIVE=PASS
GHOSTRAIL_SEGMENTATION=PASS
MAP_MODES_PRESERVED=PASS
MANUAL_CAMERA_PRESERVED=PASS
PAGEERROR=0
HORIZONTAL_OVERFLOW=0
MOBILE_QA=PASS
A22_PHYSICAL_VALIDATION=NOT_EXECUTED_ENV_BLOCKED
```

## Semantic security scanner

The release scanner is implemented at:

```text
scripts/security/native-sharing-release-scan.py
scripts/security/native_sharing_release_scan_core.py
tests/security/native-sharing-release-scan.test.py
tests/security/fixtures/native-sharing-release-scan/
```

It separately analyzes executable product code, structural Cloudflare configuration and effective workflow `run` commands. Findings emit only:

```json
{"ruleId":"RULE_ID","filePath":"relative/path"}
```

```text
SCANNER_UNIT_TESTS=PASS
SAFE_FIXTURE_ACCEPTED=PASS
ALL_FORBIDDEN_FIXTURES_REJECTED=PASS
EXPECTED_RULE_IDS=PASS
EXPECTED_FILE_PATHS=PASS
SCANNER_SELF_MATCH=NO
SCANNER_OUTPUT_SANITIZED=PASS
REAL_REPOSITORY_SCOPE=PASS
SECURITY_RELEASE_SCAN=PASS
```

## Exact technical-green evidence

```text
TECHNICAL_GREEN_SHA=35826d7bdf5a7546cbaf8d9b1795d4210ba6fed5
WORKFLOW_RUN_ID=29971586732
WORKFLOW_CONCLUSION=success
ARTIFACT_ID=8549891196
ARTIFACT_DIGEST=sha256:d58664df8415d872a9b49710860fa7724ac718bfcec324d2587c0c0f9ef237ac
```

Artifact contents are exactly:

```text
browser-qa.json
_gates.json=ABSENT
gates.json
manifest.json
sha256sums.txt
```

The `_gates.json=ABSENT` line is an explicit negative invariant; the archive itself contains exactly four files: `browser-qa.json`, `gates.json`, `manifest.json` and `sha256sums.txt`.

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

## Technical validation state

```text
STACKED_BASE_CHECK=PASS
PR_6_FROZEN=PASS
PR_7_NOT_IN_RELEASE_STACK=PASS
FROZEN_INSTALL=PASS
BACKEND_REGRESSION=PASS
ESLINT=PASS
TYPECHECK=PASS
NATIVE_SHARING_TYPECHECK=PASS
NATIVE_SHARING_TESTS=PASS
VECTOR_MAP_REGRESSION=PASS
STATIC_EXPORT_BUILD=PASS
NATIVE_SHARING_BROWSER_QA=PASS
SECURITY_AND_RELEASE_GATES=PASS
PREPARE_SANITIZED_ARTIFACT=PASS
SECURITY_ARTIFACT_SCAN=PASS
ARTIFACT_CURRENT_HEAD=PASS
FINAL_INTEGRITY=PASS
CI_FINAL=SUCCESS
```

## Runtime and production status

```text
POC_RUNTIME=IN_MEMORY_AND_MOCKS_ONLY
PRODUCTION_RUNTIME=RENDER
PRODUCTION_URL=https://strackerglm.onrender.com/
PRODUCTION_MODIFIED=NO
CLOUDFLARE_LIVE_MODIFIED=NO
PRODUCTION_TRAFFIC=0%
ROLLBACK_EXECUTED=NO
```

Production remains on the previous Render runtime. PR #8 was not merged or deployed.

## Open risks

- Browser geolocation can be throttled or suspended in the background; STRACKER does not promise closed-browser tracking.
- Capability leakage through the recipient's own screenshots or intentional redistribution cannot be prevented; rotation and revocation limit exposure.
- The in-memory PoC is not durable and is not a production runtime.
- Durable Object SQLite behavior, alarms, concurrency and quotas are not yet implemented or validated in this branch.
- OpenFreeMap and EOx public services have no STRACKER-controlled SLA.
- EOxCloudless is historical 10 m imagery, not current high-resolution imagery.
- Physical Samsung Galaxy A22 performance remains unverified.
- Production remains on Render until a separately authorized cutover phase.

## Release posture

```text
PR_8_TECHNICALLY_GREEN_SHA=35826d7bdf5a7546cbaf8d9b1795d4210ba6fed5
PR_8_STATE=OPEN_DRAFT
PR_8_MERGE=NO
PR_8_DEPLOY=NO
NO_MORE_COMMITS=PENDING_FINAL_DOCUMENTATION_RUN
PRODUCTION_DEPLOY=NO
FULL_CLOUDFLARE_CUTOVER=NO_GO
```

## Next exact phase

After the documentation HEAD passes the same complete pipeline, freeze PR #8. Then create a separate Draft PR stacked on the final PR #8 HEAD for a code-only Cloudflare runtime with a SQLite-backed `NativeSharingDurableObject`, placeholder non-routable configuration, synthetic tests and dry-run validation only. Stop before creating any live Cloudflare resource.
