# STRACKER — Current State

## Canonical baseline

```text
P0_BRANCH=fix/stracker-p0-security-canonical-state
P0_HEAD_SHA=fa919edad57937481f97e74ac96f09697bf03642
MOBILE_BRANCH=feat/stracker-mobile-session-product-v1
MOBILE_HEAD_SHA=166bf8e316cabd4806ade4fb4c21a20d2ad2040a
GATEWAY_POC_BRANCH=feat/stracker-cloudflare-private-gateway-poc
GATEWAY_POC_HEAD_SHA=77a937b4b157c2ec2c47940d6fe6891cf10b74c9
CURRENT_BRANCH=feat/stracker-cloudflare-nonprod-live-v1
CURRENT_HEAD_SHA=SEE_CURRENT_DRAFT_PR_HEAD
PR_BASE=feat/stracker-cloudflare-private-gateway-poc
DRAFT_PR=PENDING_GITHUB_ASSIGNMENT
PRODUCTION_MODIFIED=NO
RENDER_MODIFIED=NO
DNS_MODIFIED=NO
PRODUCTION_TRAFFIC=0%
```

PR #4 is frozen as the validated code PoC. This branch is the fourth stacked engineering PR and may modify only non-production Cloudflare staging resources.

## Architecture boundary

```text
SERVICE_BINDING=WORKER_TO_WORKER_ONLY
SERVICE_BINDING_TARGET=stracker-backend-mock-staging
GATEWAY_WORKER=stracker-gateway-staging
RENDER_INTEGRATION=NOT_PART_OF_THIS_PHASE
```

The staging Service Binding does not connect to Render. Any later Render integration requires a fixed fetch to an allowlisted HTTPS origin or a dedicated origin-adapter Worker.

## Candidate state

- Mobile static export is compiled with `NEXT_PUBLIC_STRACKER_STAGING_MOCK=1`.
- The staging UI is visibly labeled synthetic and does not present the real Google-cookie importer.
- `MI UBICACIÓN` remains browser-local and independent from the shared backend.
- `UBICACIÓN COMPARTIDA` accepts only the synthetic marker `MOCK_SESSION_ONLY` in staging.
- The mock backend stores nothing and uses only the synthetic Null Island fixture.
- The gateway protects both assets and APIs with Access JWT validation.
- API requests use an exact route/method allowlist and fixed Service Binding.
- Browser headers are discarded and the staging token is injected only inside the gateway.
- Backend response redirects and `Set-Cookie` are blocked or stripped.

## Planned Cloudflare resources

```text
BACKEND_WORKER=stracker-backend-mock-staging
BACKEND_WORKERS_DEV=false
BACKEND_PREVIEW_URLS=false
BACKEND_ROUTES=none
GATEWAY_WORKER=stracker-gateway-staging
GATEWAY_PREVIEW_URLS=false
GATEWAY_SURFACE=single Access-protected workers.dev URL
ACCESS_SCOPE=entire staging Worker
ACCESS_DEFAULT=deny
ACCESS_ALLOW=exact authorized operator only
```

## Validation state

```text
STACKED_BASE_CHECK=PENDING_CURRENT_HEAD_CI
FROZEN_INSTALL=PENDING_CURRENT_HEAD_CI
ESLINT=PENDING_CURRENT_HEAD_CI
TYPECHECK=PENDING_CURRENT_HEAD_CI
STATIC_EXPORT_BUILD=PENDING_CURRENT_HEAD_CI
BACKEND_TESTS=PENDING_CURRENT_HEAD_CI
GATEWAY_TESTS=PENDING_CURRENT_HEAD_CI
WRANGLER_DRY_RUN=PENDING_CURRENT_HEAD_CI
MOCK_BACKEND_VERSION=PENDING_LIVE_WORKFLOW
MOCK_BACKEND_DEPLOYMENT=PENDING_LIVE_WORKFLOW
GATEWAY_VERSION=PENDING_LIVE_WORKFLOW
GATEWAY_DEPLOYMENT=PENDING_LIVE_WORKFLOW
ACCESS_APPLICATION=PENDING_LIVE_WORKFLOW
ACCESS_DEFAULT_DENY=PENDING_LIVE_WORKFLOW
UNAUTHENTICATED_BLOCKED=PENDING_LIVE_WORKFLOW
AUTHENTICATED_BROWSER=PENDING_LIVE_WORKFLOW
SERVICE_BINDING_LIVE=PENDING_LIVE_WORKFLOW
MOBILE_LIVE_QA=PENDING_LIVE_WORKFLOW
CI_FINAL=PENDING_CURRENT_HEAD_CI
```

The newest `STRACKER Cloudflare Nonprod Live V1` workflow associated with the current Draft PR head is authoritative. A green local job does not imply that Cloudflare resources exist; the separate live-staging job must provide Version, Deployment and Access evidence.

## Security and operational risks

- The repository remains public and historical sensitive material still requires separate remediation and potential rotation.
- A GitHub Actions Cloudflare credential with Workers and Access permissions must already exist; the workflow will not create or print a broad permanent token.
- An exact operator identity must be supplied or safely resolved as the sole active account member.
- Authenticated browser QA requires an existing short-lived Access session. Absence or expiry is an external blocker and must not cause Access to be weakened.
- Render filesystem persistence and the undocumented Google Location Sharing endpoint remain unrelated open risks.
- Code rollback is not data rollback. This staging phase intentionally creates no KV, D1, R2 or Durable Object data.

## Release posture

```text
FULL_CLOUDFLARE_CUTOVER=NO_GO
RENDER_PRODUCTION=UNCHANGED
PR_1_MERGE=NO
PR_2_MERGE=NO
PR_4_MERGE=NO
CURRENT_PR_MERGE=NO
PRODUCTION_DEPLOY=NO
```

## Next exact step

Publish the fourth stacked Draft PR and run its current-head workflow. If the remote credential, exact operator identity and authenticated Access session are available, complete live staging and reconcile this file with sanitized IDs. If any is unavailable, record the exact external blocker while keeping production untouched and any created staging surface Access-protected.
