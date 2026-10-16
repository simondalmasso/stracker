# STRACKER

STRACKER combines location tracking, shared-location continuity, map visualization, and a Santa Fe 3D-map pilot. The repository is in recovery/validation; a successful build or green unit test does **not** certify a public release.

## Current release status

**ORDER-006: BLOCKED_REAL.** The latest recorded controlled-candidate probe found coherent build/version metadata and an exact 3D manifest, but the PMTiles range request returned HTTP 502. The release workflow now treats pull-request updates as validation-only; production promotion requires a manual workflow dispatch, explicit authorization, and the `STRACKER_ORDER006_RELEASE_APPROVED=true` repository variable. The production environment's protection settings still need verification.

Public runtime: https://stracker.simondalmasso44.workers.dev/

## Repository map

- `src/` — Next.js/React application and maintained UI components.
- `tracker_map.py` — Python tracker/state engine and legacy map renderer.
- `native-sharing-cloudflare/` — Cloudflare Worker runtime for shared-location and PMTiles transport.
- `public/data/santa-fe-3d/` — Santa Fe 3D asset manifest and content-addressed map archives.
- `scripts/release/` — candidate coherence, release, rollback, and browser-QA automation.
- `tests/vector-map/` — vector-map and release-contract tests.
- `tests/native-sharing-cloudflare/` — Worker and PMTiles transport contract tests.
- `nextjs-ui/` — legacy generated static snapshot; rebuild it from maintained source before using it as a release artifact.
- `worklog.md` — sanitized recovery notes.

## Local development

Requires Bun, Node.js, and Python. Install dependencies with:

```sh
bun install --frozen-lockfile
```

Common checks:

```sh
bun run lint
bun run typecheck
bun run test:vector-map
bun run test:backend
bun run build
```

The repository also contains gateway and Cloudflare Worker-specific tests; use the scripts in `package.json` for the relevant subsystem. Do not treat `next.config.ts` build success alone as proof that the production Worker serves the same source SHA.

## Privacy and configuration

- Never commit `.env`, cookies, session handles, access tokens, raw location histories, exact home/work coordinates, or raw diagnostic transcripts.
- `tracker_map.py` accepts optional owner-configured backend zones through `STRACKER_HOME_ZONE_CENTER`, `STRACKER_WORK_ZONE_CENTER`, and `STRACKER_USER_HOME_CENTER` at runtime. Keep those values in a private runtime configuration, never in this public repository.
- Client-side home/work geofencing and route-to-home are disabled by default until a safe per-user configuration path exists. The public map fallback is a coarse city-center location, not a person's home.
- The old `tool-results/` transcript was removed because it mixed diagnostic output with private location data.

## Release gates

Do not promote until all ORDER-006 requirements are evidenced against the exact public source SHA: PMTiles Range returns 206 with correct headers and byte length; session remains active through the desktop zoom-torture sequence; 3D remains continuous through zoom/style/context changes; GhostRail retains the required 24-hour history; branding and manifests agree; and owner desktop/A22 physical smoke tests pass. Synthetic browser tests cannot replace human physical validation.

Proposed GitHub About description: **Privacy-conscious location tracking and continuous 3D urban mapping, built around MapLibre, PMTiles, and Cloudflare Workers.**

Proposed topics: `location-tracking`, `geospatial`, `maplibre`, `pmtiles`, `cloudflare-workers`, `nextjs`, `3d-maps`, `santa-fe-argentina`.
