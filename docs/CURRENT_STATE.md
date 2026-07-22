# STRACKER — Current State

## Canonical remote stack

```text
P0_BRANCH=fix/stracker-p0-security-canonical-state
P0_HEAD_SHA=fa919edad57937481f97e74ac96f09697bf03642
MOBILE_BRANCH=feat/stracker-mobile-session-product-v1
MOBILE_HEAD_SHA=166bf8e316cabd4806ade4fb4c21a20d2ad2040a
GATEWAY_BRANCH=feat/stracker-cloudflare-private-gateway-poc
GATEWAY_HEAD_SHA=77a937b4b157c2ec2c47940d6fe6891cf10b74c9
VECTOR_BRANCH=feat/stracker-vector-map-engine-v1
VECTOR_HEAD_SHA=8a3ac8d750b107e24f5ce744f15a0bbae9767f1f
CURRENT_BRANCH=feat/stracker-zero-cost-cloudflare-runtime-poc
CURRENT_HEAD_SHA=SEE_DRAFT_PR_HEAD
PR_BASE=feat/stracker-vector-map-engine-v1
DRAFT_PR=7
PRODUCTION_MODIFIED=NO
DEPLOYMENT_EXECUTED=NO
MERGE_EXECUTED=NO
PRODUCTION_TRAFFIC=0%
```

PR #1, PR #2, PR #4 and PR #6 remain frozen and unmodified by this phase.

## Phase objective

```text
NEXT_PHASE=stracker-zero-cost-cloudflare-runtime-poc
RUNTIME=Cloudflare Worker TypeScript
STATIC_ASSETS=Cloudflare Workers Static Assets
SESSION_STORAGE=D1
SESSION_ENCRYPTION=AES-256-GCM_WEB_CRYPTO
FIXTURES=SYNTHETIC_ONLY
```

No Cloudflare resource, identity provider, database, Worker version, deployment, route, DNS record or secret has been created.

## Identity and Google Maps session

```text
GOOGLE_IDENTITY_LOGIN
GOOGLE_MAPS_SESSION_LINK
```

```text
GOOGLE_ID_TOKEN_OR_ACCESS_IDENTITY
!=
GOOGLE_MAPS_SESSION
!=
STRACKER_SERVICE_TOKEN
```

Cloudflare Access owns application login. When live infrastructure is separately authorized, Access uses Google as the identity provider and presents the login action before STRACKER. React does not duplicate Google authentication.

`UBICACIÓN COMPARTIDA` owns Google Maps session linkage. It presents `VINCULAR GOOGLE MAPS`, secondary text `Importar una sesión autorizada`, a sanitized state and `ABRIR UBICACIÓN` only after a valid linked session has produced an acceptable shared-location state.

States:

```text
NO VINCULADA
VALIDANDO
VINCULADA
SESIÓN VENCIDA
SESIÓN RECHAZADA
GOOGLE NO DISPONIBLE
```

Identity and Maps sessions expire or revoke independently.

## Runtime request flow

```text
Browser
→ Cloudflare Access assertion validation
→ exact API route allowlist
→ D1 lookup by SHA-256(Access subject)
→ AES-GCM decrypt in Worker memory
→ fixed Google Maps Location Sharing request
→ bounded parser
→ sanitized response
```

An accepted Access identity without a linked Google Maps session receives `SHARED_SESSION_REQUIRED`. Identity alone never unlocks shared location.

## Session import

Supported synthetic-test formats:

```text
Cookie Editor JSON
wrapped JSON array/string
Cookie Header String
Netscape
```

Server-side gates:

- maximum import size;
- Google-domain allowlist;
- cookie normalization and deduplication;
- expiry filtering;
- critical-cookie completeness;
- fixed upstream URL and headers;
- bounded upstream response;
- acceptable live response classification before storage;
- AES-GCM encryption before D1 upsert;
- no cookie values in public responses, logs or artifacts.

## D1 decision

D1 is selected instead of Durable Objects because the phase stores one small relational encrypted record per Access subject and does not require WebSockets, alarms or coordinated stateful execution. Free-plan quota exhaustion must fail operations. Paid-plan activation or automatic overage is prohibited.

```text
RECURRING_INFRASTRUCTURE_COST_USD=0
PAID_OVERAGE_ALLOWED=NO
AUTOMATIC_UPGRADE_TO_PAID=NO
BILLING_DEPENDENCY=NO
WORKERS_PLAN=FREE_REQUIRED
D1_PLAN=FREE_REQUIRED
FAIL_MODE=FAIL_CLOSED_REQUIRED
```

## Cartographic baseline preserved

```text
RENDERER=MapLibre GL JS
DEFAULT_BASEMAP_MODE=vector-3d
BASEMAP_MODES=vector-3d|satellite|hybrid
MAP_PROVIDER_COST_USD=0
SECOND_RENDERER=ABSENT
```

The frontend remains a static export and retains MAPA 3D, SATÉLITE and HÍBRIDO from PR #6.

## Required validation

```text
STACKED_BASE_CHECK=PENDING_CI
FROZEN_INSTALL=PENDING_CI
BACKEND_TESTS=PENDING_CI
ESLINT=PENDING_CI
TYPECHECK=PENDING_CI
RUNTIME_TYPECHECK=PENDING_CI
RUNTIME_TESTS=PENDING_CI
IDENTITY_SESSION_BROWSER_QA=PENDING_CI
STATIC_EXPORT_BUILD=PENDING_CI
WRANGLER_DRY_RUN=PENDING_CI
FINAL_BUNDLE_SINGLE_ENGINE=PENDING_CI
GOOGLE_LOGIN_DOES_NOT_UNLOCK_SHARED_LOCATION=PENDING_CI
SHARED_SESSION_REQUIRED=PENDING_CI
IDENTITY_AND_SESSION_SEPARATED=PENDING_CI
NO_FALSE_OAUTH_CLAIM=PENDING_CI
SECURITY_ARTIFACT_SCAN=PENDING_CI
CI_FINAL=PENDING_CI
```

## Known risks

- Google Maps Location Sharing remains undocumented and may change.
- Google IdP, Access, D1 and secret bindings are not live-validated in this phase.
- Workers Free CPU limits may be restrictive for large imports or upstream responses.
- D1 quota exhaustion blocks reads or writes until limits reset or data is removed.
- Code rollback does not revert persistent D1 state.
- Physical Samsung Galaxy A22 validation remains `NOT_EXECUTED_ENV_BLOCKED`.

## Release posture

```text
PR_1_MERGE=NO
PR_2_MERGE=NO
PR_4_MERGE=NO
PR_6_MERGE=NO
CURRENT_PR_MERGE=NO
PRODUCTION_DEPLOY=NO
DNS_CHANGE=NO
REAL_SECRETS=NO
REAL_GOOGLE_SESSION=NO
REAL_LOCATION_DATA=NO
```

## Next exact step

Complete exact-head CI and artifact inspection for the new Draft PR. Do not create live Cloudflare resources without separate authorization.
