# STRACKER — Vector Map Engine Decision V1

## Decision

```text
SELECTED_RENDERER=MapLibre GL JS
SELECTED_STYLE_PROVIDER=OpenFreeMap
SELECTED_BASE_DATA=OpenStreetMap/OpenMapTiles-compatible vector data
MAPBOX_ROLE=BENCHMARK_ONLY
ZERO_COST_HARD_GATE=PASS
PAID_OVERAGE_RISK=NO
```

The release uses one renderer only. Mapbox GL JS is not a dependency, route, token source or runtime provider in the final product bundle.

## Product constraints

```text
RECURRING_INFRASTRUCTURE_COST_USD=0
MAP_PROVIDER_COST_USD=0
PAID_OVERAGE_ALLOWED=NO
AUTOMATIC_UPGRADE_TO_PAID=NO
BILLING_DEPENDENCY=NO
```

A provider that offers a free allowance followed by metered charges does not satisfy the STRACKER hard gate.

## Candidate A — Mapbox GL JS v3 with Mapbox data/style

Renderer capabilities are strong: GPU vector rendering, camera control, terrain/buildings and mature styles. The isolated CI spike uses only local synthetic GeoJSON and no Mapbox token or data request, so it benchmarks renderer behavior without exposing STRACKER data.

Mapbox is not selected because its documented pay-as-you-go model permits billable usage after the included allowance and does not provide the required project-level hard spending cap before charges. Performance or style quality cannot override this economic failure.

```text
MAPBOX_RENDERER_BENCHMARK=ALLOWED
MAPBOX_PRODUCTION_ELIGIBILITY=FAIL_ZERO_COST_HARD_GATE
MAPBOX_TOKEN_IN_RELEASE=NO
MAPBOX_DATA_REQUEST_IN_RELEASE=NO
```

## Candidate B — MapLibre GL JS with OpenFreeMap and OpenStreetMap

MapLibre provides the required WebGL vector renderer, camera APIs, GeoJSON sources, custom layers and 3D fill extrusion without a proprietary renderer account or token.

OpenFreeMap currently provides public vector styles and tiles without registration or API keys and documents no usage billing. The selected style endpoint is:

```text
https://tiles.openfreemap.org/styles/liberty
```

The runtime displays visible attribution to OpenFreeMap, OpenMapTiles and OpenStreetMap.

## Coverage and 3D

The selected OpenFreeMap style is based on OpenMapTiles-compatible vector data derived from OpenStreetMap. Santa Fe street coverage is evaluated by live CI requests and the physical-device checklist. Building extrusion uses the `building` source layer and height fields when available, with a conservative fallback height only for rendered building footprints; this does not invent location samples or movement.

Building completeness and height accuracy depend on upstream OpenStreetMap/OpenMapTiles coverage. Missing height metadata is a map-data limitation and must not be presented as authoritative building height.

## Renderer spike

The CI benchmark routes are isolated from the release:

```text
/maplibre → MapLibre UMD bundle
/mapbox   → transient /tmp Mapbox UMD bundle
```

Both receive the same local synthetic GeoJSON fixture:

```text
STRACKER_SYNTHETIC_SANTA_FE_RENDERER_FIXTURE
```

The benchmark records:

- renderer package version;
- JavaScript and CSS bytes;
- first load and idle time;
- WebGL availability and renderer string;
- 3D fill-extrusion availability;
- camera result;
- estimated FPS;
- long tasks;
- optional heap metrics;
- unexpected external requests.

Mapbox is installed transiently during the benchmark job and is absent from `package.json`, `bun.lock`, application source and exported assets.

## Availability and operational risk

The public OpenFreeMap service is provided as-is and without a contractual SLA. It may change or become unavailable. STRACKER therefore keeps renderer, provider URL and application layers behind an adapter.

Fail-closed does not mean hiding the product if tiles fail. Source and privacy controls remain active while the map presents an explicit unavailable/degraded state. A later migration can target self-hosted OpenFreeMap-compatible tiles or PMTiles without changing motion, freshness, GhostRail or camera logic.

## PMTiles preparation

PMTiles is not implemented in this PR. The adapter boundary reserves the migration point:

```text
MapEngineAdapter
→ style/provider configuration
→ source/layer contracts
```

No source classifier or location pipeline imports MapLibre, OpenFreeMap or a tile URL.

## Final release assertions

```text
FINAL_BUNDLE_SINGLE_ENGINE=PASS
UNSELECTED_ENGINE_ABSENT=PASS
MAPBOX_DEPENDENCY=ABSENT
LEAFLET_DEPENDENCY=ABSENT
MAP_PROVIDER_TOKEN=ABSENT
ATTRIBUTION_REQUIRED=YES
NEXT_PHASE=stracker-zero-cost-cloudflare-runtime-poc
```
