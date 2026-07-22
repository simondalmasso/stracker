# STRACKER Deployment Controls

## Current platform

Production remains on Render. Draft PR #6 performs no deployment, changes no production environment variable and creates no Cloudflare resource.

```text
PRODUCTION_MODIFIED=NO
DEPLOY=NO
MERGE=NO
DNS_MODIFIED=NO
RENDER_MODIFIED=NO
```

## Vector map release stack

```text
MapLibre GL JS
+ OpenFreeMap public style/tiles
+ OpenStreetMap/OpenMapTiles-compatible data
```

The release requires no map-provider token or billing account. Mapbox and Leaflet are absent from runtime dependencies and exported assets.

The public OpenFreeMap service is an external availability dependency but not a billing dependency. A production release must revalidate provider terms, availability, attribution and observed browser requests on the exact source SHA.

## Static export

The mobile product remains a direct static Next.js export:

```text
BUILD_EXPORT=1 bunx next build
```

The exported application must contain one engine only. It may not dynamically download or select Mapbox or Leaflet at runtime.

## Required environment names

Backend runtime requirements remain unchanged:

- `STRACKER_ENV=production`;
- `STRACKER_API_TOKEN` — high-entropy service credential;
- `SECRET_KEY` — high-entropy encryption material;
- `CORS_ALLOWED_ORIGINS` — explicit allowlist;
- platform controls such as `PORT` as required.

Map runtime:

```text
MAPBOX_ACCESS_TOKEN=PROHIBITED
OPENFREEMAP_API_TOKEN=NOT_REQUIRED
MAP_PROVIDER_BILLING_ACCOUNT=NOT_REQUIRED
```

Values and secrets must never be committed, logged or embedded in browser assets.

## Pre-deployment gates

1. Exact source SHA and clean tree recorded.
2. Bun frozen install succeeds from the committed lockfile.
3. Python compile, backend tests and duplicate tracker parity succeed.
4. ESLint, typecheck, pure map tests and static export succeed.
5. Final export contains MapLibre and the OpenFreeMap style endpoint only.
6. Mapbox, Leaflet, tokens and previous raster endpoints are absent.
7. Source selector, permissions and request-order gates pass.
8. Source change and late-response isolation pass.
9. GhostRail segmentation and manual camera invariants pass.
10. Attribution is visible and accessible at all required viewports.
11. Raw mobile and renderer-spike artifacts exist for the exact SHA.
12. Provider privacy and zero-cost decision are revalidated.
13. Physical A22 evidence is marked honestly.
14. Rollback target and provider-degradation behavior are recorded.
15. Production promotion receives separate explicit authorization.

## Performance fallback

On constrained devices or WebGL recovery:

1. reduce pitch;
2. reduce 3D density;
3. disable terrain;
4. simplify effects;
5. preserve MapLibre vector 2D.

Terrain is not enabled in this PR.

## Rollback

This branch is not deployed, so rollback is not executed. A future code rollback does not restore browser memory, backend storage or external map-provider state. The selected map adapter must permit provider/style replacement without changing the location pipeline.

## Next phase

```text
NEXT_PHASE=stracker-zero-cost-cloudflare-runtime-poc
```

That phase is separate and must test HTTP probing, parser parity, AES-GCM with Web Crypto, non-ephemeral storage, Cloudflare Free limits and synthetic fail-closed parity. It must not be folded into this vector-map PR.
