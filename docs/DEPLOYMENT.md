# STRACKER Deployment Controls

## Current platform

Production remains on Render. This branch performs no deployment and changes no production environment variables.

## Required environment names

- `STRACKER_ENV=production`
- `STRACKER_API_TOKEN` — high-entropy service credential, at least 32 characters.
- `SECRET_KEY` — high-entropy encryption key material, at least 32 characters.
- `CORS_ALLOWED_ORIGINS` — explicit comma-separated allowlist.
- Existing non-secret runtime controls such as `PORT` and `TRACKER_SKIP_PLAYWRIGHT` as required by the platform.

Values must be configured in the deployment platform, never in Git, screenshots, logs or PR text.

## Pre-deployment gates

1. Exact source SHA and clean tree recorded.
2. Secret audit reviewed and active credentials rotated where required.
3. Python syntax and focused backend tests pass.
4. Frontend lint, typecheck and build results are compared with the base SHA.
5. A staging credential is configured and unauthorized/authorized smokes are executed.
6. Rollback target is recorded.
7. Production promotion receives separate explicit authorization.

## Rollback

This P0 branch has not been deployed; rollback is not applicable. A future Render promotion must preserve the prior deployment and must not assume that code rollback restores filesystem data.
