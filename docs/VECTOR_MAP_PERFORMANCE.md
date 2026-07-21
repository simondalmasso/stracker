# STRACKER — Map Performance V2

## Machine-readable budgets

```text
docs/performance/VECTOR_MAP_BUDGETS.json
```

Budgets cover initial route transfer, map visibility/interactivity, active RAF rate, long tasks, memory growth, GhostRail bounds and separate vector/raster provider traffic.

## Separate provider measurements

Vector and satellite traffic are not combined into one opaque total:

```text
VECTOR_REQUESTS
VECTOR_TRANSFERRED_BYTES
RASTER_REQUESTS
RASTER_TRANSFERRED_BYTES
```

The current CI budgets are:

```text
VECTOR_PROVIDER_REQUESTS_FIRST_VIEWPORT_MAX=90
VECTOR_PROVIDER_TRANSFERRED_BYTES_FIRST_VIEWPORT_MAX=10000000
RASTER_PROVIDER_REQUESTS_FIRST_VIEWPORT_MAX=40
RASTER_PROVIDER_TRANSFERRED_BYTES_FIRST_VIEWPORT_MAX=12000000
```

These are CI Chromium guardrails, not physical-device performance claims or provider quotas.

## Exact-head evidence

CI produces two sanitized artifacts:

```text
stracker-vector-map-mobile-qa-<SHA>
stracker-vector-map-spike-<SHA>
```

The mobile artifact contains:

- five required mobile viewports;
- pageerror, console and overflow evidence;
- source, marker, GhostRail and manual-camera preservation across all three modes;
- no-new-geolocation and no-new-session-request checks;
- provider-failure UI evidence;
- separate vector/raster transfer measurements;
- memory and reduced-motion results.

The renderer/provider artifact contains:

- isolated MapLibre/Mapbox renderer benchmark results;
- OpenFreeMap live style/tile evidence;
- EOx WMTS capabilities and public Santa Fe tile evidence;
- zero-cost/license/CORS/provider-policy gates;
- explicit non-claims for complete IGN orthomosaic coverage.

No artifact may contain cookies, authorization headers, service tokens, source archives or retained coordinate values.

## Basemap transitions

The QA sequence validates:

```text
VECTOR_TO_SATELLITE
SATELLITE_TO_HYBRID
HYBRID_TO_VECTOR
```

The same MapLibre canvas must survive every transition. Location source, accepted marker, GhostRail count, capture timestamp, watcher count, session-request count and manual camera mode must remain unchanged.

## Raster failure and fallback

Raster failures must become visible as `SATÉLITE NO DISPONIBLE EN ESTA ZONA`. A failed raster tile is not treated as a successful empty view. No paid or unauthorized provider is loaded automatically.

## Memory and WebGL

GhostRail remains bounded to 600 accepted points. Rejected and metadata-only observations do not extend it.

The WebGL fallback sequence remains:

1. reduce pitch;
2. reduce 3D density;
3. disable terrain;
4. simplify effects;
5. retain MapLibre vector 2D;
6. show explicit satellite unavailability when the raster source fails.

## Physical Samsung Galaxy A22 4G

```text
A22_PHYSICAL_VALIDATION=NOT_EXECUTED_ENV_BLOCKED
PHYSICAL_DEVICE_EVIDENCE_HONEST=PASS_REQUIRED
```

CI and emulation results may not be relabeled as physical A22 evidence.
