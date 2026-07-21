# STRACKER Security Model

## Data classification

Locations, trajectories, timestamps, device telemetry and Google session cookies are highly sensitive. They must not be public, cached, logged verbatim or committed to Git.

## Production boundary

Production remains on Render and is outside the Cloudflare non-production staging phase. Existing protected Render routes use server-configured credentials. No production token, encryption key, Google cookie or session may be copied into staging.

## Non-production Cloudflare boundary

```text
Authorized operator identity
→ Cloudflare Access default deny
→ stracker-gateway-staging
→ server-side synthetic token injection
→ Worker Service Binding
→ stracker-backend-mock-staging
```

The Service Binding is Worker-to-Worker only. It is not an external-origin connector and does not connect directly to Render.

The gateway validates `Cf-Access-Jwt-Assertion` with RS256, exact `kid`, trusted team JWKS origin, issuer, audience, signature, `exp`, `nbf` and `iat`. The Access cookie itself is not trusted by application code.

## Access policy

The entire staging Worker is protected. The application has one exact operator allow policy; all unmatched requests are denied. No `everyone`, bypass or service-token rule is permitted. A Cloudflare service token is not used as normal mobile login.

The full operator email must not appear in logs, artifacts, documentation or assistant responses. Sanitized evidence uses a SHA-256 identity hash.

## Origin service token

`STRACKER_SERVICE_TOKEN` is random and staging-only. It is stored exclusively as a secret binding in both staging Workers. It is never a Wrangler var and never enters the browser, source tree, logs or evidence artifact.

Browser-supplied values for `Authorization`, `Cookie`, `Cf-Access-Jwt-Assertion`, `X-Stracker-Service-Token`, forwarding headers and arbitrary secret headers are discarded before the Service Binding call.

## Synthetic backend

The mock backend:

- has no public route, workers.dev URL or preview URL;
- accepts only the fixed internal origin used by the Service Binding;
- validates the staging service token and gateway marker;
- rejects leaked client-sensitive headers;
- accepts only `MOCK_SESSION_ONLY`;
- persists nothing;
- returns only `STRACKER_STAGING_SYNTHETIC_V1` data;
- uses `0,0` with explicit synthetic labels rather than plausible personal coordinates.

## Gateway allowlist

```text
GET  /api/session/status
POST /api/session/import
POST /api/session/delete
GET  /points
GET|HEAD /
GET|HEAD /_next/*
GET|HEAD /favicon.ico
```

Query strings, unknown routes, unsupported methods, client-selected origins and redirects are blocked. Sensitive API responses use `Cache-Control: no-store`. `Set-Cookie` and arbitrary upstream headers are stripped.

## Fail-closed behavior

- No Access assertion: blocked.
- Invalid JWT or JWKS: blocked.
- Missing Service Binding: `503`.
- Missing secret: `503`.
- Backend unavailable: `502`.
- Missing gateway attestation in the mobile client: blocked.
- Access cannot be established before workers.dev exposure: abort remote exposure.

## Static mobile mode

The staging build is compiled with a visible synthetic mode. It removes the real-session entry surface and does not persist coordinates. `MI UBICACIÓN` uses browser geolocation only and must not call shared APIs.

## Incident and rollback

A live security-gate failure disables the gateway workers.dev surface first, keeps Access default-deny, and restores the previous staging Worker versions when available. Production is never part of the rollback.

```text
ACCESS_IDENTITY != ORIGIN_SERVICE_TOKEN
SERVICE_BINDING != EXTERNAL_ORIGIN
CODE_ROLLBACK != DATA_ROLLBACK
```
