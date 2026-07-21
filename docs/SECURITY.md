# STRACKER Security Model

## Data classification

Location, trajectories, timestamps, device telemetry and Google session cookies are highly sensitive. They must not be public, cached, logged verbatim or committed to Git.

## Transitional backend authentication

Protected routes require a server-configured `STRACKER_API_TOKEN` with at least 32 characters. Accepted transports:

- `Authorization: Bearer <token>` for controlled clients.
- `X-Stracker-Service-Token: <token>` for the future Cloudflare Worker-to-Render gateway.

Tokens are compared with `hmac.compare_digest`. Missing server configuration returns a generic `503`; missing or incorrect credentials return a generic `401`. CORS remains defense-in-depth and is not authentication. The previous browser-generated Bearer token module was removed from the active source path.

The root Next.js shell is not protected by this transitional mechanism because browser subresources cannot safely attach a manually entered Bearer token. Full UI protection is assigned to Cloudflare Access in the next phase. All endpoints capable of returning or mutating sensitive data are protected now.

## Runtime modes

`STRACKER_ENV` accepts `development`, `test`, or `production`.

In production, startup fails before tracking or HTTP serving unless:

- `STRACKER_API_TOKEN` is valid;
- `SECRET_KEY` contains at least 32 characters;
- AES-GCM support is available.

No source-code fallback key exists. Tests use explicit environment-only test material.

## Static file policy

The Python server uses a fail-closed allowlist. Public files are limited to the root application shell and known frontend assets. Sensitive files, repository metadata, logs, histories, profiles and audit inputs return 404.

## Protected routes

`/points`, `/api/cookies`, `/cookies`, `/cookies.html`, `/predict`, `/api/archive`, `/archive`, `/ghostrail/encrypted`, `/health/details`, and the legacy `/mapa.html` surface require server-side authentication.

`/historial.csv`, logs, encrypted blobs and other internal files are never served as static files.

## Manual incident actions

This PR does not rotate credentials, revoke Google sessions, rewrite Git history or change repository visibility. Any audit item marked `required_if_active` must be handled manually after explicit authorization.
