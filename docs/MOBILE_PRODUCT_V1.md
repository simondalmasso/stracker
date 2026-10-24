# STRACKER Mobile Product V1

## Product source model

`LocationSource` is strictly `my-device` or `google-shared`. Snapshots without a source are rejected by TypeScript contracts. The UI never renders data from both sources in one active map state.

## My location

Uses `navigator.geolocation.watchPosition()` only after an explicit button press. The last known coordinate is kept in this browser's localStorage until browser site data is cleared so a reload can reopen the map in paused/stale mode; old coordinates are explicitly marked stale and are not uploaded by default. Background tracking is not promised.

## Shared location

Google does not expose a documented general-purpose Location Sharing consumption API for STRACKER. The honest product wording is **Vincular sesión de Google Maps**. The backend accepts Cookie Editor JSON, wrapped JSON, Cookie Header String and Netscape; normalizes allowed Google domains; checks critical cookie names; performs a real upstream probe; and stores atomically only after a valid or valid-without-location classification.

## Isometric atlas

The default map uses a MapLibre/OpenFreeMap vector style with 2.5D building extrusions, following the isometric-map direction of https://tiny.london/. Tiny London itself is a London-only pixel-art map and does not expose a documented public map SDK for overlaying STRACKER's live coordinates, so its proprietary canvas is not embedded. Satellite imagery is a separate, on-demand base view; the app does not offer a hybrid mode. GhostRail remains an independent STRACKER overlay.

## Session and GhostRail persistence

The selected source is remembered in browser localStorage; on reload the app must re-check the server-side shared-session status before showing the import form. Google cookies themselves are never stored in browser storage. Google can still expire or revoke those cookies, which STRACKER cannot prevent.

For the backend session and GhostRail history to survive process restarts/redeploys, mount durable storage and configure STRACKER_SESSION_PATH, STRACKER_HISTORY_PATH, STRACKER_GHOSTRAIL_PATH, and STRACKER_GHOSTRAIL_ARCHIVE_PATH to files on that volume. The default paths are inside the application directory and are not durable on hosts with ephemeral filesystems. Do not declare continuity complete until the mount and a restart-recovery test are verified.

## Build

Canonical package manager: Bun 1.3.4 with `bun.lock`. Release gates use `bun install --frozen-lockfile`, lint, independent typecheck and static export build. The legacy Next.js API routes were removed because the canonical backend is Python behind a future gateway; retaining executable Next API routes made static export non-reproducible and duplicated backend authority.

## Legacy exclusion

`src/components/tracker/**` is retained only as non-executable legacy reference during gradual migration. It is excluded narrowly from the mobile V1 lint/typecheck graph because the root product no longer imports it. Removal/refactor remains a follow-up task.

## Security

The browser never receives Google cookie values or the Render service token. A future non-production Cloudflare gateway will attach `X-Stracker-Service-Token` server-side. No deployment is included in this branch.
