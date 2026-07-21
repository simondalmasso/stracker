# STRACKER — Cloudflare Resource Inventory

## Inventory policy

This document records names and non-secret operational identifiers only. It must never contain service-token values, Access cookies, full operator email addresses, Google cookies, sessions or coordinates.

The current-head workflow produces a sanitized artifact named:

```text
stracker-cloudflare-nonprod-live-<WORKFLOW_MERGE_SHA>
```

The workflow artifact is authoritative for Version IDs, Deployment IDs, Access identifiers, worker states and the external blocker. Documentation must never convert a missing identifier into a claimed resource.

## Intended staging resources

| Resource | Name | Public ingress | Purpose |
|---|---|---:|---|
| Worker | `stracker-backend-mock-staging` | None | Internal synthetic backend reached only by Service Binding |
| Worker | `stracker-gateway-staging` | Access-protected `workers.dev` only | Mobile Static Assets and private API gateway |
| Service Binding | `STRACKER_BACKEND` | Internal | `stracker-gateway-staging` → `stracker-backend-mock-staging` |
| Secret binding | `STRACKER_SERVICE_TOKEN` | Never exposed | Synthetic Worker-to-Worker authentication |
| Assets binding | `ASSETS` | Through protected gateway | Static mobile export |
| Access application | `STRACKER Gateway Staging` | Entire Worker | Default deny with exact operator allow policy |

## Last verified inventory

```text
WORKFLOW_RUN_ID=29841023127
VALIDATED_BRANCH_HEAD=4dfc157f9993b5b9f9a412fa5ea3244e24e3e7c7
WORKFLOW_MERGE_SHA=6e982a08426fcbd44c0d90468fb64b105998755e
ARTIFACT_ID=8499388421
ARTIFACT_DIGEST=sha256:fc1db3839c98d0feac13df8460214aa56f485153b01dba5d3e765d00ee77ffa2
EXTERNAL_BLOCKER=CLOUDFLARE_CREDENTIAL_NOT_AVAILABLE
```

The fail-closed preflight stopped before the first Cloudflare API mutation. The sanitized artifact records:

```text
BACKEND_WORKER_NAME=stracker-backend-mock-staging
BACKEND_VERSION_ID=NONE
BACKEND_DEPLOYMENT_ID=NONE
BACKEND_WORKERS_DEV=false
BACKEND_PREVIEW_URLS=false
BACKEND_ROUTES=none

GATEWAY_WORKER_NAME=stracker-gateway-staging
GATEWAY_VERSION_ID=NONE
GATEWAY_DEPLOYMENT_ID=NONE
GATEWAY_WORKERS_DEV=false
GATEWAY_PREVIEW_URLS=false
GATEWAY_ROUTES=none

ACCESS_APPLICATION_ID=NONE
ACCESS_POLICY_ID=NONE
ACCESS_AUDIENCE=NONE
ACCESS_TEAM_DOMAIN=NONE
OPERATOR_IDENTITY_HASH=NONE
STAGING_URL=NONE
PRODUCTION_TRAFFIC=0%
RENDER_MODIFIED=NO
DNS_MODIFIED=NO
```

These are intended names with null remote identifiers, not pre-existing Cloudflare resources.

## Binding names in the candidate

Backend mock:

```text
STRACKER_SERVICE_TOKEN    secret
```

Gateway:

```text
ASSETS                    static assets
STRACKER_BACKEND          Worker Service Binding
STRACKER_SERVICE_TOKEN    secret
ACCESS_TEAM_DOMAIN        non-secret configuration
ACCESS_AUD                non-secret configuration
```

## Architecture assertions

```text
SERVICE_BINDING=WORKER_TO_WORKER_ONLY
RENDER_INTEGRATION=NOT_PART_OF_THIS_PHASE
SERVICE_BINDING != EXTERNAL_ORIGIN
STAGING_DEPLOYMENT != PRODUCTION_DEPLOYMENT
WORKER_VERSION != WORKER_DEPLOYMENT
ACCESS_IDENTITY != ORIGIN_SERVICE_TOKEN
CODE_ROLLBACK != DATA_ROLLBACK
```

## Prohibited inventory content

- secret values;
- full email addresses;
- Access authorization cookies;
- JWTs;
- Google cookie names paired with values;
- real coordinates;
- Render credentials;
- production API tokens.
