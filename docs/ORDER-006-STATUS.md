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
