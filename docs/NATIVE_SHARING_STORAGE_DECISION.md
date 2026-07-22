# STRACKER — Native Sharing Storage Decision

## Decision

```text
LIVE_CANDIDATE=Durable Objects with SQLite storage
POC_EXECUTION_STORE=InMemoryNativeSharingStore
D1_CANDIDATE=RETAINED_NOT_SELECTED
LIVE_BINDING_CREATED=NO
```

This decision applies only to the native location-sharing workload. It does not inherit the D1 decision made by the separate experimental Google runtime spike.

## Workload characteristics

A native session has:

- one emitter publishing sequential observations;
- multiple viewers reading status and confirmed points;
- strict monotonic sequence and replay rejection;
- immediate viewer-capability rotation;
- immediate session revocation;
- bounded expiry and cleanup;
- per-session rate and retention state;
- concurrent requests that must not cross a revocation or sequence boundary.

The primary consistency atom is one sharing session.

## Why Durable Objects are preferred

A Durable Object can be addressed deterministically from the random session ID and act as the serialized authority for that one session. This matches:

```text
one session
→ one coordination object
→ one ordered write stream
→ one revocation/rotation authority
```

Expected advantages:

- serialized per-session mutations;
- atomic sequence advancement and point insertion;
- rotation and revocation ordered against concurrent publications;
- local SQLite tables for session metadata and bounded points;
- no global object bottleneck when objects are sharded by session ID;
- direct mapping between domain consistency and storage ownership.

The candidate adapter deliberately routes by session name and exposes the same `NativeSharingStore` interface. It is not configured or deployed in this phase.

## Why D1 is not selected for V1 live authority

D1 remains technically capable of relational persistence, querying and cleanup, but the native workload requires additional proof for:

- conditional monotonic sequence updates under concurrency;
- ordering publication against revocation;
- atomic viewer-verifier rotation;
- avoiding duplicate acceptance during concurrent writes;
- per-session hot-write behavior;
- deterministic cleanup without widening authority.

A D1 implementation would need transactions or conditional update patterns that are tested against concurrent requests, not only unit-tested SQL. The present `D1NativeSharingStoreCandidate` is intentionally fail-closed and cannot be enabled accidentally.

D1 may remain useful later for sanitized operational indexes or asynchronous aggregate data, but it is not the session authority selected here.

## In-memory adapter

`InMemoryNativeSharingStore` is the only executable adapter in this PoC. It provides:

- create/get session;
- expected-sequence append;
- latest point;
- confirmed segmentation;
- revoke;
- rotate viewer verifier;
- expiry deletion.

It is suitable only for deterministic tests. It is not durable, multi-instance safe or production eligible.

## Proposed Durable Object schema

```sql
CREATE TABLE session_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  session_id TEXT NOT NULL,
  emitter_verifier TEXT NOT NULL,
  viewer_verifier TEXT NOT NULL,
  viewer_generation INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_sequence INTEGER NOT NULL,
  last_captured_at TEXT,
  last_received_at TEXT,
  point_count INTEGER NOT NULL
);

CREATE TABLE points (
  sequence INTEGER PRIMARY KEY,
  payload_ciphertext BLOB NOT NULL,
  captured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  segment_id INTEGER NOT NULL
);
```

Before any live implementation, coordinate payloads must be encrypted at rest with authenticated encryption and a key supplied through a secret binding. The current PoC intentionally does not create that binding or persist real coordinates.

## Retention and cleanup

The object must enforce domain limits before insertion:

```text
MAX_SESSION_DURATION=4h
MAX_POINTS_PER_SESSION=2880
MIN_POINT_INTERVAL=5s
MAX_GHOSTRAIL_SEGMENTS=64
DELETE_AFTER_EXPIRATION=24h
```

An alarm or bounded cleanup operation may remove expired state. An alarm is an implementation candidate, not part of this PoC. Expired and revoked states must block reads/writes immediately even before physical deletion.

## Zero-cost boundary

A future live experiment may proceed only if all required resources remain on Cloudflare Free and are configured to fail closed at limits:

```text
RECURRING_INFRASTRUCTURE_COST_USD=0
PAID_OVERAGE_ALLOWED=NO
AUTOMATIC_UPGRADE_TO_PAID=NO
BILLING_DEPENDENCY=NO
```

No assumption that a paid plan will remain unused is acceptable. The experiment must verify account plan, quotas and limit behavior before creating a resource.

## Rollback boundary

Code rollback does not automatically revert or delete persistent object storage. A future live plan must separately define:

- schema migration rollback;
- capability invalidation;
- point deletion;
- expiry cleanup;
- secret rotation;
- evidence that no old version can continue accepting writes.

## Status

```text
IN_MEMORY_TESTS=IMPLEMENTED
D1_CANDIDATE=INTERFACE_PRESENT_FAIL_CLOSED
DURABLE_OBJECT_CANDIDATE=ADAPTER_PRESENT_NOT_BOUND
REAL_D1=NOT_CREATED
REAL_DURABLE_OBJECT=NOT_CREATED
REAL_STORAGE_DATA=ABSENT
PRODUCTION_ELIGIBLE=NO
```
