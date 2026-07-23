# STRACKER — Current State

## Canonical milestone

```text
ACTIVE_PHASE=NATIVE_SHARING_CLOUDFLARE_RUNTIME_V1_CODE_ONLY
ACTIVE_BRANCH=feat/stracker-native-sharing-cloudflare-runtime-v1
ACTIVE_DRAFT_PR=9
PR_BASE=feat/stracker-native-location-sharing-v1
PR_BASE_SHA=b001814b675fb8c8cf2713ff4728cd250e8a25c8
CURRENT_HEAD_SHA=SEE_DRAFT_PR_9_HEAD
CURRENT_REWORK=EXPORTS_SQLITE_ATOMICITY_WORKERD
PR_9_STATE=OPEN_DRAFT
PR_9_TECHNICALLY_READY=NO
FINAL_ARTIFACT=NO
MERGE_EXECUTED=NO
DEPLOYMENT_EXECUTED=NO
PRODUCTION_MODIFIED=NO
PRODUCTION_TRAFFIC=0%
```

PR #9 remains stacked directly on the final frozen head of PR #8. It is not based on PR #7 and contains no merge or cherry-pick from PR #7.

```text
PR_6_ROLE=FROZEN_VECTOR_MAP_ENGINE_BASE
PR_6_HEAD_SHA=8a3ac8d750b107e24f5ce744f15a0bbae9767f1f

PR_7_ROLE=EXPERIMENTAL_GOOGLE_RUNTIME_SPIKE
PR_7_RELEASE_DEPENDENCY=NO
PR_7_PRODUCTION_CANDIDATE=NO
PR_7_IN_PR_9_ANCESTRY=NO

PR_8_ROLE=FROZEN_NATIVE_LOCATION_SHARING_PRODUCT
PR_8_HEAD_SHA=b001814b675fb8c8cf2713ff4728cd250e8a25c8
PR_8_FINAL_RUN_ID=29971797092
PR_8_MERGE=NO
PR_8_DEPLOY=NO
```

## Superseded Phase B baseline

The following evidence is preserved because it documents the prior code-only checkpoint, but it does not satisfy the current exports, transaction and workerd contract:

```text
LEGACY_BASELINE_SHA=1b8bc4b79c63e36f5f6d7bb8a7fc39f0a782c930
LEGACY_BASELINE_RUN=29974437874
LEGACY_BASELINE_ARTIFACT=8550899250
LEGACY_GREEN_SCOPE=SUPERSEDED_CONTRACT_ONLY
PHASE_B_FINAL_EVIDENCE=NO
```

The legacy run and artifact must not be used to declare PR #9 technically ready. They predate the declarative `exports` lifecycle, real multi-step SQLite transaction boundaries and the workerd atomicity proof.

## Canonical product boundary

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

Google remains disabled in this release line:

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
CAPABILITY_EXCHANGE_REQUIRED=YES
FRAGMENT_REMOVED_AFTER_EXCHANGE=YES
CAPABILITY_NOT_REUSED_FOR_POLLING=YES
VIEWER_SESSION=OPAQUE_SHORT_LIVED_MEMORY_ONLY
```

The fragment capability is exchanged once after explicit confirmation. Polling uses a short-lived opaque viewer session in `Authorization: Bearer`; neither capability nor viewer session is persisted in URL, local storage, session storage, IndexedDB or JS-readable cookies.

## Phase B code-only architecture

```text
Browser
→ stateless Worker gateway
→ Native Sharing API
→ one NativeSharingDurableObject per SESSION_ID
→ private SQLite database attached to that object
→ Static Assets
```

Deterministic routing uses `env.NATIVE_SHARING.getByName(sessionId)`. Each sharing session maps to one object and one private SQLite database. No live Worker, namespace, route or deployment exists.

## Declarative Durable Object lifecycle

`native-sharing-cloudflare/wrangler.jsonc` now declares the class through:

```json
"exports": {
  "NativeSharingDurableObject": {
    "type": "durable-object",
    "storage": "sqlite"
  }
}
```

```text
DO_LIFECYCLE_CONFIG=EXPORTS
SQLITE_STORAGE_DECLARED=YES
MIGRATIONS_PRESENT=NO
EXPORTS_AND_MIGRATIONS_COEXIST=NO
NATIVE_SHARING_BINDING=PRESENT
workers_dev=false
preview_urls=false
observability.enabled=false
routes=ABSENT
custom_domains=ABSENT
account_id=ABSENT
zone_id=ABSENT
```

Worker-first paths remain:

```text
/api/share/*
/shared
/shared/*
```

## SQLite schema

The current per-session schema is:

```text
sharing_session
accepted_points
viewer_sessions
rate_or_sequence_state
```

The schema enforces a singleton sharing-session row, primary keys, unique capability verifiers where applicable, checks on state and numeric domains, point sequence indexes and active-viewer indexes. Only capability and viewer-session verifiers are stored; complete tokens and capabilities are absent.

## Transaction boundaries

The architectural rule is:

```text
TRANSACTION_SYNC_FOR_EVERY_SQL_WRITE=NO
TRANSACTION_SYNC_FOR_IDENTIFIED_MULTI_STEP_MUTATIONS=YES
```

`transactionSync()` is used for identified read/validate/conditional-write operations:

```text
CREATE_SESSION_SQL_STATE
APPEND_POINT
CREATE_VIEWER_SESSION_WITH_LIMIT
ROTATE_VIEWER_AND_INVALIDATE
REVOKE_SESSION_AND_INVALIDATE
EXPIRATION_SQL_CLEANUP
```

### Create session SQL state

The sharing-session row and `rate_or_sequence_state` row are inserted in one SQLite transaction. Failure of the second insert rolls back the first insert.

Scheduling the alarm is not falsely described as part of the SQLite transaction. The flow is:

```text
CREATE_SQL_SESSION
→ SET_ALARM
→ SUCCESS
```

If `setAlarm()` fails:

```text
ctx.storage.deleteAll()
→ verify sharing_session absent
→ verify accepted_points absent
→ verify viewer_sessions absent
→ verify rate_or_sequence_state absent
→ verify alarm absent
→ sanitized STORAGE_UNAVAILABLE
```

### Append point

Within one transaction:

```text
READ_SESSION_AND_PREVIOUS_POINT
→ VALIDATE_STATE_SEQUENCE_AND_QUOTA
→ CALCULATE_SEGMENT
→ CONDITIONAL_SESSION_UPDATE
→ REQUIRE_ROWS_WRITTEN_EQ_1
→ CONDITIONAL_SEQUENCE_STATE_UPDATE
→ REQUIRE_ROWS_WRITTEN_EQ_1
→ INSERT_ACCEPTED_POINT
→ REQUIRE_ROWS_WRITTEN_EQ_1
→ ROLLBACK_ON_ANY_FAILURE
```

A point cannot remain inserted without its counters, and counters cannot remain advanced without the point.

### Viewer exchange

Cryptographic capability verification may occur before the transaction. The transaction then revalidates:

```text
SESSION_ID_MATCH
SESSION_STATE=active
SESSION_EXPIRES_AT>NOW
VIEWER_VERIFIER=EXPECTED_VERIFIER
VIEWER_GENERATION=EXPECTED_GENERATION
```

Only after those checks, in the same transaction:

```text
PURGE_EXPIRED_VIEWERS
COUNT_ACTIVE_VIEWERS
ENFORCE_LIMIT
INSERT_VIEWER_SESSION
REQUIRE_ROWS_WRITTEN_EQ_1
```

Rotation, revocation or expiration between preverification and insertion causes no viewer-session insert and returns a sanitized invalid or inactive result.

### Rotation and revocation

Viewer generation update and active-viewer invalidation are atomic. Sharing-session revocation and active-viewer invalidation are atomic.

## Alarm cleanup

At the cleanup deadline, the Durable Object calls `ctx.storage.deleteAll()` to remove SQL state, metadata and the alarm. Cleanup is idempotent. If post-delete verification is negative, `alarm()` throws `STORAGE_CLEANUP_UNVERIFIED`; it does not silently report success.

## Validation status for current rework

The prior Browser QA and four-file artifact remain historical only. They are not current Phase B evidence.

```text
FROZEN_INSTALL=PENDING_CURRENT_HEAD_CI
WRANGLER_TYPES=PENDING_CURRENT_HEAD_CI
TYPECHECK=PENDING_CURRENT_HEAD_CI
LINT=PENDING_CURRENT_HEAD_CI
BUN_ADAPTER_TESTS=PENDING_CURRENT_HEAD_CI
CLOUDFLARE_WORKER_VITEST=PENDING_CURRENT_HEAD_CI
SQLITE_TRANSACTION_TESTS=PENDING_CURRENT_HEAD_CI
ALARM_COMPENSATION_TESTS=PENDING_CURRENT_HEAD_CI
VIEWER_EXCHANGE_TRANSACTIONAL_REVALIDATION=PENDING_CURRENT_HEAD_CI
LIFECYCLE_SCANNER_FIXTURES=PENDING_CURRENT_HEAD_CI
RUNTIME_SECURITY_SCAN=PENDING_CURRENT_HEAD_CI
WRANGLER_DRY_RUN=PENDING_CURRENT_HEAD_CI
RUN_CONCLUSION=PENDING
```

The current workerd suite is required to prove:

```text
EXPORTS_CONFIG_LOADS
SQLITE_SCHEMA_EXISTS
CREATE_SESSION_TWO_INSERT_ROLLBACK
APPEND_POINT_ROLLBACK
APPEND_POINT_ROWS_WRITTEN_RACE
VIEWER_EXCHANGE_GENERATION_RACE
VIEWER_LIMIT_CONCURRENT
ROTATION_ATOMIC
REVOCATION_ATOMIC
SET_ALARM_FAILURE_DELETE_ALL
ALARM_CLEANUP_VERIFICATION_FAILURE
```

The Bun SQLite adapter remains Level 1 unit/adapter evidence only. It is not called Worker SQLite E2E.

## Explicitly outside the current tranche

```text
QUOTA_MODEL_REWORK=NOT_STARTED
POLLING_INCREMENTAL=NOT_STARTED
TIMEOUT_IDEMPOTENCY=NOT_STARTED
FINAL_BROWSER_QA=NOT_EXECUTED
FINAL_SCANNER=NOT_EXECUTED
FINAL_SIX_FILE_ARTIFACT=NOT_CREATED
PR_BODY_FINALIZATION=NOT_EXECUTED
```

No current gate may claim:

```text
WORKER_SQLITE_E2E=PASS
LATE_RESPONSE_BLOCKED=PASS
RETENTION_BOUNDED=PASS
FINAL_ARTIFACT=PASS
```

## Production and live-control-plane status

```text
PRODUCTION_RUNTIME=RENDER
PRODUCTION_URL=https://strackerglm.onrender.com/
PRODUCTION_MODIFIED=NO
RENDER_MODIFIED=NO
CLOUDFLARE_LIVE_MODIFIED=NO
WORKER_LIVE_CREATED=NO
DURABLE_OBJECT_NAMESPACE_LIVE_CREATED=NO
VERSION_UPLOAD_EXECUTED=NO
DEPLOYMENT_EXECUTED=NO
ACCESS_APPLICATION_CREATED=NO
GOOGLE_IDP_CREATED=NO
ROUTE_CREATED=NO
DNS_MODIFIED=NO
SECRET_CREATED=NO
REAL_LOCATION_SESSION_CREATED=NO
PRODUCTION_TRAFFIC=0%
MERGE=NO
DEPLOY=NO
LIVE_INFRASTRUCTURE=NO
```

## Open risks

```text
WORKERD_ATOMICITY_RESULTS=PENDING
WRANGLER_EXPORTS_COMPATIBILITY=PENDING_CI
FROZEN_LOCK_VALIDATION=PENDING_CI
VIEWER_GENERATION_RACE_PROOF=PENDING_CI
ALARM_COMPENSATION_PROOF=PENDING_CI
A22_PHYSICAL_VALIDATION=NOT_EXECUTED_ENV_BLOCKED
```

## Next exact step

Run the intermediate Phase B pipeline on the exact current PR #9 HEAD. Correct only failures in frozen install, exports lifecycle, SQLite transaction boundaries, workerd atomicity, alarm compensation, lifecycle scanner, security scan or dry-run. Do not start quota, incremental polling, timeout/idempotency, final Browser QA or final artifact work without a new decision.
