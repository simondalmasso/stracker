# STRACKER — Cloudflare Resource Inventory

## Inventory policy

This document records names and non-secret operational identifiers only. It must never contain service-token values, Access cookies, full operator email addresses, Google cookies, sessions or coordinates.

The current-head workflow produces a sanitized JSON artifact named:

```text
stracker-cloudflare-nonprod-live-<SOURCE_SHA>
```

After a successful live run, the artifact is authoritative for Version IDs, Deployment IDs, Access application ID, policy ID, worker states and the hashed operator identity. `docs/CURRENT_STATE.md` must then be reconciled with those exact values.

## Expected staging resources

| Resource | Name | Public ingress | Purpose |
|---|---|---:|---|
| Worker | `stracker-backend-mock-staging` | None | Internal synthetic backend reached only by Service Binding |
| Worker | `stracker-gateway-staging` | Access-protected `workers.dev` only | Mobile Static Assets and private API gateway |
| Service Binding | `STRACKER_BACKEND` | Internal | `stracker-gateway-staging` → `stracker-backend-mock-staging` |
| Secret binding | `STRACKER_SERVICE_TOKEN` | Never exposed | Synthetic Worker-to-Worker authentication |
| Assets binding | `ASSETS` | Through protected gateway | Static mobile export |
| Access application | `STRACKER Gateway Staging` | Entire Worker | Default deny with exact operator allow policy |

## Current identifiers

```text
SOURCE_SHA=SEE_DRAFT_PR_HEAD
BACKEND_VERSION_ID=PENDING_LIVE_WORKFLOW
BACKEND_DEPLOYMENT_ID=PENDING_LIVE_WORKFLOW
GATEWAY_VERSION_ID=PENDING_LIVE_WORKFLOW
GATEWAY_DEPLOYMENT_ID=PENDING_LIVE_WORKFLOW
ACCESS_APPLICATION_ID=PENDING_LIVE_WORKFLOW
ACCESS_POLICY_ID=PENDING_LIVE_WORKFLOW
STAGING_URL=PENDING_LIVE_WORKFLOW
PRODUCTION_TRAFFIC=0%
```

## Binding names

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

## Prohibited inventory content

- secret values;
- full email addresses;
- Access authorization cookies;
- JWTs;
- Google cookie names paired with values;
- real coordinates;
- Render credentials;
- production API tokens.
