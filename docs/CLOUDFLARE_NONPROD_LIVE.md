# STRACKER — Cloudflare Non-Production Live V1

## Scope

This stacked phase may create and validate only isolated Cloudflare staging resources with synthetic data.

```text
BASE_BRANCH=feat/stracker-cloudflare-private-gateway-poc
BASE_SHA=77a937b4b157c2ec2c47940d6fe6891cf10b74c9
BRANCH=feat/stracker-cloudflare-nonprod-live-v1
PR_BASE=feat/stracker-cloudflare-private-gateway-poc
PRODUCTION_TRAFFIC=0%
RENDER_INTEGRATION=NOT_PART_OF_THIS_PHASE
SERVICE_BINDING=WORKER_TO_WORKER_ONLY
```

Production Render, DNS, custom domains, productive routes, Google cookies, real sessions, real coordinates and production secrets are excluded.

## Architecture

```text
Authorized operator browser
→ Cloudflare Access protecting the entire staging Worker
→ stracker-gateway-staging
   ├─ Static Assets binding → mobile static export
   └─ STRACKER_BACKEND Service Binding
      → stracker-backend-mock-staging
```

The Service Binding is an internal Worker-to-Worker transport. It is not an external-origin connector and does not connect to Render.

A future Render phase must use either:

```text
fixed fetch to an explicit allowlisted HTTPS origin
or
a dedicated origin-adapter Worker
```

## Resources

### `stracker-backend-mock-staging`

- `workers_dev=false`;
- `preview_urls=false`;
- no routes or custom domains;
- no public ingress;
- deployed only so the gateway can call it through a Service Binding;
- one secret binding named `STRACKER_SERVICE_TOKEN`;
- no persistence;
- no cookies;
- synthetic dataset only: `STRACKER_STAGING_SYNTHETIC_V1`;
- location fixtures use Null Island (`0,0`) and are labeled `SYNTHETIC_NULL_ISLAND_NOT_REAL`.

Controlled states:

```text
session_valid
session_absent
session_expired
location_fresh
location_stale
no_location
timeout
upstream_error
redirect
set_cookie
```

The last two scenarios exist only to verify gateway response sanitization.

### `stracker-gateway-staging`

- serves static mobile assets and API routes from one origin;
- exact API allowlist only;
- rejects query strings, unknown routes and unknown methods;
- validates the Cloudflare Access assertion independently inside the Worker;
- reconstructs upstream headers;
- adds `X-Stracker-Service-Token` from a secret binding only;
- calls only `STRACKER_BACKEND` through the fixed Service Binding;
- strips redirects, `Set-Cookie` and arbitrary backend headers;
- keeps `preview_urls=false`;
- enables one `workers.dev` staging surface only after Access is verified default-deny.

## Access sequence

The remote workflow follows this order:

1. Resolve an exact Cloudflare account and operator identity without printing the full email.
2. Verify the account Zero Trust organization and team domain.
3. Upload and deploy the private mock backend.
4. Upload and deploy the gateway bootstrap with `workers_dev=false`.
5. Create or reconcile an Access application targeting the exact Worker.
6. Remove prior staging policies and create one exact operator-email allow policy.
7. Verify there is no `everyone`, bypass or service-token policy.
8. Upload and deploy the final gateway version with the exact Access audience.
9. Enable `workers.dev` with preview URLs disabled.
10. Immediately prove unauthenticated requests are stopped by Access before the Worker.

If the platform requires public exposure before Access can target the Worker, the workflow must abort with:

```text
ABORT_REMOTE_EXPOSURE
```

## Secrets

The workflow generates a new random staging-only `STRACKER_SERVICE_TOKEN`. The value exists only in masked runner memory and a mode-0600 temporary secrets file used by `wrangler versions upload --secrets-file`.

It must never appear in:

- Wrangler vars;
- committed configuration;
- GitHub source;
- logs;
- artifacts;
- HTML;
- JavaScript bundles;
- source maps;
- screenshots;
- documentation.

`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are non-secret runtime configuration.

## Version and deployment flow

The workflow never uses `wrangler deploy`.

```text
wrangler versions upload
→ capture and inspect Version ID
→ inspect binding names
→ wrangler versions deploy <version>@100%
→ capture and verify Deployment ID
```

A Worker Version is an immutable candidate. A Worker Deployment selects the active version. They are not interchangeable.

## Live validation

Unauthenticated:

```text
GET  /
GET  /points
POST /api/session/import
```

All must be blocked by Access before a gateway response exists.

Authenticated validation requires an already authorized, short-lived `CF_Authorization` session supplied outside Git. The normal mobile login remains an operator identity through One-Time PIN or an existing identity provider. A Cloudflare service token is not used as the normal user login.

The live browser suite covers five mobile viewports, synthetic geolocation, source isolation, watcher cleanup, static assets, shared mock activation and gateway attestation.

## Rollback

Before each staging deployment the workflow records the previous active version. A security failure triggers:

1. disable the gateway `workers.dev` surface;
2. retain Access default-deny;
3. restore the previous gateway version when one exists;
4. restore the previous backend version when one exists;
5. retain sanitized evidence;
6. leave production untouched.

A code rollback does not roll back KV, D1, R2, Durable Objects or external data. This phase creates none of those resources.

## Semantic boundaries

```text
SERVICE_BINDING != EXTERNAL_ORIGIN
STAGING_DEPLOYMENT != PRODUCTION_DEPLOYMENT
WORKER_VERSION != WORKER_DEPLOYMENT
ACCESS_IDENTITY != ORIGIN_SERVICE_TOKEN
CODE_ROLLBACK != DATA_ROLLBACK
```
