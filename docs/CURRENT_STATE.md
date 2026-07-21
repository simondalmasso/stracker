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
CURRENT_HEAD_SHA=SEE_DRAFT_PR_5_HEAD
PR_BASE=feat/stracker-cloudflare-private-gateway-poc
DRAFT_PR=5
PRODUCTION_MODIFIED=NO
RENDER_MODIFIED=NO
DNS_MODIFIED=NO
PRODUCTION_TRAFFIC=0%
```

PR #4 is frozen as the validated code PoC. Draft PR #5 is the fourth stacked engineering PR and may modify only non-production Cloudflare staging resources.

## Architecture boundary

```text
SERVICE_BINDING=WORKER_TO_WORKER_ONLY
SERVICE_BINDING_TARGET=stracker-backend-mock-staging
GATEWAY_WORKER=stracker-gateway-staging
RENDER_INTEGRATION=NOT_PART_OF_THIS_PHASE
```

The staging Service Binding does not connect to Render. Any later Render integration requires a fixed fetch to an allowlisted HTTPS origin or a dedicated origin-adapter Worker.

## Implemented candidate

- Mobile static export is compiled with `NEXT_PUBLIC_STRACKER_STAGING_MOCK=1`.
- The staging UI is visibly labeled synthetic and does not present the real Google-cookie importer.
- `MI UBICACIÓN` remains browser-local and independent from the shared backend.
- `UBICACIÓN COMPARTIDA` accepts only the synthetic marker `MOCK_SESSION_ONLY` in staging.
- The mock backend stores nothing and uses only the synthetic Null Island fixture.
- The gateway protects both assets and APIs with Access JWT validation.
- API requests use an exact route/method allowlist and fixed Service Binding.
- Browser headers are discarded and the staging token is injected only inside the gateway.
- Backend response redirects and `Set-Cookie` are blocked or stripped.
- The remote workflow uses `wrangler versions upload` followed by `wrangler versions deploy`; `wrangler deploy` is absent.
- The rollback procedure disables staging ingress before restoring prior staging versions.

## Intended Cloudflare resources

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

## Last verified workflow evidence

```text
WORKFLOW=STRACKER Cloudflare Nonprod Live V1
RUN_ID=29841023127
VALIDATED_BRANCH_HEAD=4dfc157f9993b5b9f9a412fa5ea3244e24e3e7c7
WORKFLOW_MERGE_SHA=6e982a08426fcbd44c0d90468fb64b105998755e
LOCAL_JOB=SUCCESS
LIVE_JOB=FAILURE_EXTERNAL_BLOCKER
ARTIFACT_ID=8499388421
ARTIFACT_DIGEST=sha256:fc1db3839c98d0feac13df8460214aa56f485153b01dba5d3e765d00ee77ffa2
EXTERNAL_BLOCKER=CLOUDFLARE_CREDENTIAL_NOT_AVAILABLE
```

Local gates verified on the recorded branch head:

```text
STACKED_BASE_CHECK=PASS
FROZEN_INSTALL=PASS
ESLINT=PASS
TYPECHECK=PASS
STATIC_EXPORT_BUILD=PASS
BACKEND_TESTS=PASS
GATEWAY_TESTS=PASS
WRANGLER_DRY_RUN=PASS
MOBILE_QA=PASS
SERVICE_TOKEN_IN_BUNDLE=NO
COOKIE_VALUES=ABSENT
REAL_LOCATION_DATA=ABSENT
```

Live gates were not executed because all supported Cloudflare credential inputs in GitHub Actions were empty. The fail-closed preflight exited before the first Cloudflare API mutation.

```text
MOCK_BACKEND_VERSION=NOT_CREATED
MOCK_BACKEND_DEPLOYMENT=NOT_CREATED
GATEWAY_VERSION=NOT_CREATED
GATEWAY_DEPLOYMENT=NOT_CREATED
ACCESS_APPLICATION=NOT_CREATED
ACCESS_DEFAULT_DENY=NOT_EXECUTED
UNAUTHENTICATED_BLOCKED=NOT_EXECUTED
AUTHENTICATED_BROWSER=NOT_EXECUTED
SERVICE_BINDING_LIVE=NOT_EXECUTED
MOBILE_LIVE_QA=NOT_EXECUTED
CI_FINAL=BLOCKED_EXTERNAL_NOT_SUCCESS
```

## Verified Cloudflare resource state

The sanitized workflow inventory records:

```text
NONPROD_WORKERS_CREATED=NO
BACKEND_VERSION_ID=NONE
BACKEND_DEPLOYMENT_ID=NONE
GATEWAY_VERSION_ID=NONE
GATEWAY_DEPLOYMENT_ID=NONE
ACCESS_APPLICATION_ID=NONE
ACCESS_POLICY_ID=NONE
STAGING_URL=NONE
WORKERS_DEV_ENABLED=NO
PREVIEW_URLS_ENABLED=NO
PRODUCTION_TRAFFIC=0%
RENDER_MODIFIED=NO
DNS_MODIFIED=NO
```

No rollback was required because no mutation started.

## Security and operational risks

- The repository remains public and historical sensitive material still requires separate remediation and potential rotation.
- A minimally scoped Cloudflare credential with Workers and Access permissions is not currently available to this repository's Actions environment.
- An exact operator identity and a short-lived authenticated Access browser session remain required after the Cloudflare credential is supplied.
- Access must not be weakened or replaced with a service token for normal mobile login.
- Render filesystem persistence and the undocumented Google Location Sharing endpoint remain unrelated open risks.
- Code rollback is not data rollback. This staging phase creates no KV, D1, R2 or Durable Object data.

## Release posture

```text
FULL_CLOUDFLARE_CUTOVER=NO_GO
RENDER_PRODUCTION=UNCHANGED
PR_1_MERGE=NO
PR_2_MERGE=NO
PR_4_MERGE=NO
PR_5_MERGE=NO
PRODUCTION_DEPLOY=NO
```

## Next exact step

Provide a minimally scoped Cloudflare API token to the Draft PR #5 Actions environment under one supported secret name, then rerun the current-head workflow. Do not change Access policy, staging exposure, Render, DNS or production manually before that preflight succeeds.
