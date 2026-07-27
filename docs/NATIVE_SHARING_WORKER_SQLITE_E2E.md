# STRACKER Native Sharing Worker SQLite E2E V1

## Scope

```text
PHASE_ID=STRACKER-NATIVE-SHARING-WORKER-SQLITE-E2E-V1
BASE_BRANCH=feat/stracker-native-sharing-cloudflare-runtime-v1
BASE_SHA=2769a602d8150a562cc1fd095e95c736908c6e1f
WORK_BRANCH=feat/stracker-native-sharing-worker-sqlite-e2e-v1
LIVE_INFRASTRUCTURE=NO
MERGE=NO
DEPLOY=NO
PRODUCTION_TRAFFIC=0%
REAL_DATA=NO
```

This phase closes one narrowly defined evidence gap from the completed runtime phase: the Worker HTTP entrypoint had synthetic browser coverage backed by an in-memory test namespace, while SQLite behavior was proven through direct Durable Object RPC tests. Neither result alone demonstrated the complete HTTP Worker → Durable Object → SQLite path.

## Evidence separation

```text
BROWSER_SYNTHETIC_INTEGRATION=IN_MEMORY_NAMESPACE
BROWSER_CLAIMS_WORKER_SQLITE_E2E=NO
WORKER_SQLITE_E2E=WORKER_EXPORTS_DEFAULT_FETCH_TO_REAL_TEST_DURABLE_OBJECT_SQLITE
WORKERD_SQLITE_ATOMICITY=SEPARATE_EXISTING_PROOF
```

Browser QA remains responsible for consent, source isolation, fragment-only capability transport, map behavior, mobile viewports and client privacy. It does not claim SQLite.

The new Workerd integration test invokes the public Worker handler through `exports.default.fetch()`. The handler performs its real route, method, origin, content-type, body, authentication and timeout boundaries before calling the configured `NATIVE_SHARING` Durable Object namespace. The test then inspects the same deterministic object with `runInDurableObject()` to confirm SQLite state.

## Required lifecycle proof

The synthetic test must demonstrate:

1. `POST /api/share/sessions` creates one session and sequence-state row.
2. Only verifiers, never emitted capabilities or session tokens, are stored in SQLite.
3. `POST /points` persists one accepted point and advances sequence/count atomically.
4. Viewer exchange persists an opaque viewer-session verifier.
5. Authenticated status and points reads return confirmed stored state.
6. Rotation increments generation and invalidates the prior viewer session.
7. A newly exchanged viewer session works only for the new generation.
8. Revocation marks the sharing session revoked and leaves zero active viewers.
9. Reads and writes after revocation fail closed.
10. Cross-origin, query-bearing, wrong-method, wrong-content-type and invalid-auth requests return sanitized errors.

## Privacy and artifact boundary

```text
PRIVATE_DATA_USED=FALSE
REAL_COORDINATES_INCLUDED=FALSE
TOKENS_INCLUDED=FALSE
CAPABILITIES_INCLUDED=FALSE
AUTHORIZATION_VALUES_INCLUDED=FALSE
RAW_LOGS_INCLUDED=FALSE
SOURCE_ARCHIVE_INCLUDED=FALSE
```

Synthetic values exist only inside executable tests. The sanitized artifact records boolean gates, exact source SHA and workflow run ID; it must not retain generated session IDs, capabilities, tokens, Authorization values or point coordinates.

## Non-live boundary

The Worker configuration remains non-routable:

```text
workers_dev=false
preview_urls=false
routes=none
account_id=absent
zone_id=absent
secrets=absent
```

No Cloudflare Version upload, Deployment, route, DNS record, Access application, secret, Render change, production request or traffic shift is part of this phase.

## Completion

```text
COMPLETION_REQUIRES=STACKED_BASE_EXACT;FROZEN_INSTALL;LINT;TYPECHECK;BUILD;REGRESSIONS;WORKER_SQLITE_E2E;WORKERD_ATOMICITY;BROWSER_QA;SECURITY_SCAN;WRANGLER_DRY_RUN;ZERO_COST;SANITIZED_ARTIFACT;EXACT_HEAD_CI;AUD_HANDOFF
```

A green test without exact-head CI and downloaded-artifact verification is insufficient. `docs/CURRENT_STATE.md` and the Draft PR body are finalized only after the first green pipeline; because those writes change the SHA, the full pipeline must then pass again on the final exact head.
