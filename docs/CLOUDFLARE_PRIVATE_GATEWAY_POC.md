# STRACKER — Cloudflare Private Gateway PoC

## Scope

This stacked phase implements a non-production proof of concept for the shared-location transport boundary:

```text
Mobile browser
→ Cloudflare Access
→ private Worker gateway
→ server-side X-Stracker-Service-Token injection
→ protected STRACKER backend binding
```

The PoC does not connect to Render, production cookies, real shared sessions, real coordinates, DNS, routes, traffic, or production secrets. The end-to-end suite uses an in-memory backend mock and a generated RSA Access key pair.

## Branch and release boundary

```text
BASE_BRANCH=feat/stracker-mobile-session-product-v1
BASE_SHA=166bf8e316cabd4806ade4fb4c21a20d2ad2040a
BRANCH=feat/stracker-cloudflare-private-gateway-poc
PR_BASE=feat/stracker-mobile-session-product-v1
DEPLOYMENT=NOT_EXECUTED
VERSION_UPLOAD=NOT_EXECUTED
PRODUCTION_TRAFFIC=0%
```

PR #2 is frozen as the verified mobile baseline. This PoC is isolated in the third stacked Draft PR.

## Gateway policy

The Worker exposes only these exact pairs:

```text
GET  /api/session/status
POST /api/session/import
POST /api/session/delete
GET  /points
```

All other paths are rejected. Query strings are rejected. Methods are not inferred or forwarded. The client cannot select an upstream host, scheme, port, path, redirect target, or service binding.

The Worker uses a fixed `STRACKER_BACKEND` service binding. This is the PoC SSRF boundary. No request parameter is used to construct the upstream destination.

## Cloudflare Access validation

The Worker reads only `Cf-Access-Jwt-Assertion` for authorization. It does not trust the browser cookie as proof.

Validation requirements:

- `RS256` only;
- exact key ID lookup from the team JWKS;
- team domain restricted to an HTTPS `*.cloudflareaccess.com` origin;
- JWKS URL fixed to `/cdn-cgi/access/certs`;
- exact issuer match;
- exact audience match, including array claims;
- signature verification with Web Crypto;
- required expiration and checks for `nbf` and future `iat`;
- fail-closed on missing configuration, missing JWT, malformed JWT, unavailable JWKS, invalid claims, or invalid signature.

The test suite generates a temporary RSA key pair and never uses a real Access application or account key.

## Header boundary

The gateway does not forward browser headers. It constructs a new upstream request with only:

```text
Accept: application/json
Content-Type: application/json              # import route only
X-Stracker-Service-Token: <server binding>
X-Stracker-Gateway-Version: private-poc-v1
```

Client-supplied values for `Authorization`, `Cookie`, `Cf-Access-Jwt-Assertion`, `X-Stracker-Service-Token`, forwarding headers, and arbitrary custom secrets are discarded.

Upstream response headers are also rebuilt. `Set-Cookie`, redirects, cache directives, and arbitrary backend headers are not forwarded.

Every gateway response uses:

```text
Cache-Control: no-store, max-age=0
Pragma: no-cache
Expires: 0
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
X-Stracker-Gateway: private-poc-v1
```

Only JSON responses within the configured size limit are accepted from the backend binding.

## Mobile behavior

`MI UBICACIÓN` remains browser-local and has no dependency on Cloudflare Access, the gateway, the service token, or the shared-session API.

`UBICACIÓN COMPARTIDA` uses same-origin relative paths and requires the response attestation header:

```text
X-Stracker-Gateway: private-poc-v1
```

A direct static host, Render endpoint, missing Access policy, missing Worker binding, or non-gateway response therefore remains fail-closed with `PRIVATE_GATEWAY_REQUIRED` or a gateway authorization/configuration error.

No Render origin or service token is embedded in the mobile bundle.

## Mock end-to-end test

The mock E2E test executes:

```text
signed Access JWT
→ Worker authorization
→ POST /api/session/import with MOCK_SESSION_ONLY
→ server-side mock token injection
→ mock backend token assertion
→ GET /points
→ POST /api/session/delete
```

The mock backend asserts that sensitive client headers were removed and that only the server-side test token reached it. No real cookies, sessions, identifiers, or locations are used.

## Wrangler configuration

`gateway/wrangler.jsonc` is intentionally non-routable:

```text
workers_dev=false
preview_urls=false
routes=none
custom_domains=none
production secrets=none
```

CI runs only:

```text
wrangler versions upload --dry-run
```

No `wrangler deploy`, deployment creation, traffic promotion, DNS change, or real version upload is part of this phase.

## Required runtime bindings for a future isolated candidate

A future non-production candidate would require all of the following before upload:

```text
ACCESS_TEAM_DOMAIN=<exact Cloudflare Access team origin>
ACCESS_AUD=<non-production Access application AUD>
STRACKER_SERVICE_TOKEN=<non-production backend token secret>
STRACKER_BACKEND=<isolated backend service binding>
```

Those bindings are not provisioned by this PR. A live Render bridge remains explicitly pending.

## Validation contract

The Draft PR workflow is authoritative for the current head and must report:

```text
STACKED_BASE_CHECK=PASS
BUN_FROZEN_INSTALL=PASS
ESLINT=PASS
TYPECHECK=PASS
STATIC_EXPORT_BUILD=PASS
BACKEND_TESTS=PASS
GATEWAY_TESTS=PASS
ACCESS_JWT_VALIDATION=PASS
OPEN_PROXY=NO
SSRF=BLOCKED
SERVICE_TOKEN_IN_BUNDLE=NO
MOCK_E2E=PASS
MY_LOCATION_INDEPENDENT=PASS
SHARED_LOCATION_FAIL_CLOSED=PASS
WRANGLER_DRY_RUN=PASS
MOBILE_QA=PASS
CI_FINAL=SUCCESS
```
