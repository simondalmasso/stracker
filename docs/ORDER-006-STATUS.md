# ORDER-006 — forensic status

**State: BLOCKED_REAL**
**Cut:** 2026-10-16
**No merge or production promotion performed by this recovery patch.**

## Evidence

- Controlled-candidate run: https://github.com/simondalmasso/stracker/actions/runs/32003209442
- The candidate coherence probe reported matching build source SHA, version source SHA/version ID hash, and the expected Santa Fe 3D manifest.
- The PMTiles range probe returned HTTP 502 instead of the required HTTP 206 with exact `Content-Range`, `Content-Length`, and the transport marker.
- The old classifier mapped any PMTiles range failure to `ASSET_BINDING_VERSION_SKEW`, obscuring the transport failure. The classifier is being corrected to distinguish `PMTILES_RANGE_TRANSPORT_FAILURE` from `PMTILES_RANGE_CONTRACT_INVALID`.
- The release workflow previously allowed production promotion from pull-request synchronization. It now requires `workflow_dispatch`, the explicit `authorize_production_release` input, and `vars.STRACKER_ORDER006_RELEASE_APPROVED == 'true'`. A `production` environment is attached; its approval rules have not been verified.
- The repository includes private home/work geofence coordinates in source and generated artifacts. The recovery patch removes those literals, disables unconfigured client-side home/work geofences and route-to-home, replaces static map fallbacks with a coarse public city-center fallback, redacts the public worklog, and removes the raw `tool-results` transcript.

## Required before release

1. Verify the updated workflow run: validation jobs may run on PR updates; the release job must be skipped.
2. Diagnose and fix the PMTiles 502 at the public runtime. Unit mocks that return 206 are not evidence that Cloudflare Static Assets honors Range in production.
3. Re-run public candidate coherence only after the transport root cause is fixed; require repeated exact identity passes and a real 206 range proof.
4. Run desktop session/zoom torture: session active, no cookie exposure, no page errors, 3D continuity, and GhostRail continuity through zoom/style/context changes.
5. Verify 24-hour GhostRail persistence, PMTiles coverage/shards, manifest/branding consistency, and exact public source SHA.
6. Obtain owner desktop smoke and physical Galaxy A22 smoke evidence. Never synthesize these gates.

## Scope and limits

- This patch does not prove that the current production Worker corresponds to GitHub `main` or the candidate branch.
- `nextjs-ui/` contains a legacy generated snapshot; rebuild it from maintained source before using it as a release artifact.
- GitHub repository description/topics are proposed in the README but have not been changed because the connected GitHub actions available here do not expose repository-settings writes.
- Final state remains `BLOCKED_REAL` until every gate above has evidence.

## Dependency hardening and MapLibre v6 migration — 2026-10-16

- A dependency graph generated in isolated GitHub Actions with Bun 1.3.4 passed the high/critical audit after refreshing the lockfile and pinning the published fixes: `maplibre-gl@6.14.0`, `next@16.4.2`, `axios@1.20.0`, `sharp@0.35.5`, `brace-expansion@1.1.20`, `source-map-js@1.2.2`, `undici@7.29.1`, `browserslist@4.28.7`, and `deepmerge-ts@8.0.2`. This was candidate validation, not a release.
- MapLibre v6 is ESM-only. The map adapter and Santa Fe 3D runtime now use namespace imports; the adapter sets the bundled worker URL before constructing the map and narrows the mounted map reference for event callbacks.
- `eslint-config-next` was removed because its dependency graph brought in `braces@3.0.3`, for which the upstream advisory currently has no published patched version. TypeScript ESLint recommended rules and React Hooks recommended rules replace the previous lint configuration. Next-specific ESLint rules are temporarily absent; restore them only after their dependency chain no longer introduces the unpatched package.
- The dependency preview passed audit, lint, and vector-map tests; typecheck/build were still red on the old MapLibre default imports and nullable-map narrowing. Fresh CI on the resulting commit must prove those fixes. No merge or deployment was performed.

## Backend regression and privacy correction — 2026-10-16

- The first full validation after dependency hardening passed exact ancestry, frozen install, and the high/critical dependency audit. It then stopped at `BACKEND_REGRESSION`: `tracker_map.py` and `nextjs-ui/tracker_map.py` differed at the Google Maps URL, and the stale generated copy contained a precise coordinate absent from the maintained source.
- `nextjs-ui/tracker_map.py` is now synchronized byte-for-byte from `tracker_map.py`, removing that stale coordinate and restoring the workflow's explicit parity contract. Fresh CI must verify the correction.
- `STRACKER Santa Fe 3D Materialize V1` passed the committed-asset validator and pipeline unit tests. It normalized the `pmtiles@4.4.1` lock pin in commit `d1c7e4a`; this is not a production deployment.

- Follow-up CI found one remaining MapLibre v5-style default import in the generated browser QA fixture. The fixture now uses the v6 namespace API and serves the two module-worker assets at same-origin paths; the next CI run must validate the actual WebGL render and toggle effect.

- The first full browser pass after MapLibre v6 migration passed the static export build, dense-city render (7,700 features), cookie-session browser QA, and map/worker test. Viewer-session lifecycle QA then failed only at `CONSOLE_ERRORS_ZERO`. Its local asset server served `.mjs` workers as `application/octet-stream`; the harness now serves `.mjs` as JavaScript. Fresh browser CI must confirm this diagnosis and the session/zoom lifecycle.
