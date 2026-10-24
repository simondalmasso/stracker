# STRACKER — Cloudflare Private Gateway PoC

## Frozen baseline

```text
BASE_BRANCH=feat/stracker-mobile-session-product-v1
BASE_SHA=166bf8e316cabd4806ade4fb4c21a20d2ad2040a
BRANCH=feat/stracker-cloudflare-private-gateway-poc
HEAD_SHA=77a937b4b157c2ec2c47940d6fe6891cf10b74c9
DRAFT_PR=4
STATE=ACCEPTED_AND_FROZEN
```

The PoC validates the code boundary for:

```text
Mobile browser
→ Cloudflare Access JWT validation
→ private Worker gateway
→ server-side X-Stracker-Service-Token injection
→ fixed backend abstraction
```

It contains no production deployment, Render connection, DNS, Google cookies, real sessions, real coordinates or production secret.

## Gateway contract

Exact API routes:

```text
GET  /api/session/status
POST /api/session/import
POST /api/session/delete
GET  /points
```

The gateway rejects query strings, unknown paths and unsupported methods. The client cannot select an upstream scheme, host, port, path or redirect target. Browser headers are discarded and the upstream request is reconstructed.

The gateway validates the Access assertion with:

- RS256 only;
- exact key ID;
- JWKS restricted to the configured HTTPS `*.cloudflareaccess.com` origin;
- exact issuer and audience;
- Web Crypto signature verification;
- `exp`, `nbf` and `iat` checks;
- fail-closed behavior for missing or invalid configuration and claims.

Sensitive responses are JSON-only, size-limited and use `Cache-Control: no-store`. Redirects, `Set-Cookie` and arbitrary upstream headers are not forwarded.

## Mobile contract

`MI UBICACIÓN` remains browser-local and does not require the shared gateway.

`UBICACIÓN COMPARTIDA` uses same-origin paths and requires:

```text
X-Stracker-Gateway: private-poc-v1
```

Missing Access, gateway, binding or response attestation remains fail-closed. No Render origin or service token is embedded in the mobile bundle.

## PoC test boundary

The frozen PoC uses generated RSA keys, a synthetic test token and an in-memory backend. Its current-head CI verifies JWT validation, open-proxy resistance, SSRF blocking, header stripping, mock E2E, static export and mobile QA.

## Mandatory architectural clarification

A Cloudflare Worker Service Binding connects one Worker to another Worker. It is not an external-origin transport.

The authorized live staging phase must use exactly:

```text
stracker-gateway-staging
→ STRACKER_BACKEND Service Binding
→ stracker-backend-mock-staging
```

```text
SERVICE_BINDING=WORKER_TO_WORKER_ONLY
RENDER_INTEGRATION=NOT_PART_OF_THIS_PHASE
```

The PoC wording `protected STRACKER backend binding` must not be interpreted as a direct Render connection.

A future Render integration requires a separate architecture and authorization:

```text
fixed fetch to an explicit allowlisted HTTPS origin
or
a dedicated origin-adapter Worker
```

## Semantic boundaries

```text
SERVICE_BINDING != EXTERNAL_ORIGIN
STAGING_DEPLOYMENT != PRODUCTION_DEPLOYMENT
WORKER_VERSION != WORKER_DEPLOYMENT
ACCESS_IDENTITY != ORIGIN_SERVICE_TOKEN
CODE_ROLLBACK != DATA_ROLLBACK
```

PR #4 remains frozen. All real non-production infrastructure, IDs and live evidence belong to the next stacked Draft PR.
