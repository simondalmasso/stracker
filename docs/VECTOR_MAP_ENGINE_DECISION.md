# STRACKER — Map Engine and Basemap Decision V2

## Release decision

```text
RENDERER=MapLibre GL JS
DEFAULT_BASEMAP_MODE=vector-3d
BASEMAP_MODES=vector-3d|satellite|hybrid
VECTOR_STYLE_PROVIDER=OpenFreeMap
VECTOR_BASE_DATA=OpenStreetMap/OpenMapTiles-compatible
SATELLITE_PROVIDER=eox-s2cloudless-2016
MAPBOX_ROLE=BENCHMARK_ONLY
FINAL_BUNDLE_SINGLE_ENGINE=PASS_REQUIRED
```

The release contains one renderer. Basemap changes toggle sources and layers inside the existing MapLibre instance; they do not create another map, change `LocationSource`, restart a watcher/poll, clear product layers or mutate camera state.

## Independent state contract

```ts
type BasemapMode = 'vector-3d' | 'satellite' | 'hybrid'
```

`BasemapMode` is independent of location source, motion, freshness, source health, shared-session state and camera mode. It lives only for the current document lifetime. No localStorage, cookie, backend field or hidden URL parameter is used. A new document starts at `vector-3d`.

## Modes

### VECTOR_3D

- OpenFreeMap Liberty vector style;
- dark style adjustments;
- OpenStreetMap/OpenMapTiles-compatible streets and buildings;
- optional building extrusion;
- normal follow, stationary, overview and manual camera behavior.

### SATELLITE

- EOxCloudless 2016 raster WMTS tiles;
- no extruded buildings;
- no vector street or label overlay;
- marker, connection halo, accuracy circle and GhostRail remain above the raster.

### HYBRID

- the same EOxCloudless raster source;
- OpenFreeMap line and symbol layers above the raster for streets, boundaries and place labels;
- all STRACKER product layers remain above both basemap groups.

## Zero-cost hard gate

```text
RECURRING_INFRASTRUCTURE_COST_USD=0
MAP_PROVIDER_COST_USD=0
PAID_OVERAGE_ALLOWED=NO
AUTOMATIC_UPGRADE_TO_PAID=NO
BILLING_DEPENDENCY=NO
```

A free allowance followed by metered billing is ineligible.

## Satellite provider evaluation

### A. IGN Argenmap Híbrido

IGN publishes TMS/WMTS endpoints. It is not selected for STRACKER satellite imagery because the current public geoservice description does not provide sufficiently explicit imagery provenance and licensing for this product, while historical official Argenmap documentation identifies Google imagery. STRACKER does not silently treat that endpoint as an independently licensed satellite source.

```text
IGN_ARGENMAP_HYBRID=BLOCKED_BY_IMAGERY_PROVENANCE_AND_LICENSE_AMBIGUITY
COMPLETE_COVERAGE_CLAIMED=NO
```

### B. IGN public orthomosaics

IGN publishes public aerial-photography and VANT orthomosaic geoservices. They remain candidates for a future coverage-aware high-resolution overlay. This release does not claim that one stable layer covers all of Santa Fe, nor that capture date, resolution or availability are uniform.

```text
IGN_ORTHOMOSAICS=PARTIAL_COVERAGE_CANDIDATE_NOT_SELECTED
COMPLETE_SANTA_FE_COVERAGE_CLAIMED=NO
```

### C. EOxCloudless 2016

Selected as the authorized open fallback:

```text
ENDPOINT=https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2016_3857/default/g/{z}/{y}/{x}.jpg
API_KEY_REQUIRED=NO
COST_USD=0
PAID_OVERAGE_ALLOWED=NO
BILLING_DEPENDENCY=NO
LICENSE=CC BY 4.0
RESOLUTION=10 m
MAX_ZOOM=14
IMAGERY_PERIOD=2016-2017 mosaic
RECENT_IMAGERY_CLAIM=NO
COMPLETE_COVERAGE_CLAIMED=NO
```

Required attribution is retained in policy and displayed in satellite/hybrid UI. The imagery is explicitly historical; STRACKER does not call it current or recent.

## Failure behavior

Raster source errors produce the visible state:

```text
SATÉLITE NO DISPONIBLE EN ESTA ZONA
```

Location tracking remains active and isolated. Empty or failed tiles are not hidden as success. No automatic substitution to Google, Mapbox, paid ArcGIS or MapTiler occurs.

## Benchmark boundary

Mapbox is installed only under `/tmp` in the CI renderer benchmark and receives local synthetic GeoJSON. It remains absent from package metadata, lockfile, source runtime and exported assets.

## Release assertions

```text
RENDERER=MapLibre GL JS
NO_SECOND_RENDERER=PASS_REQUIRED
UNSELECTED_ENGINE_ABSENT=PASS_REQUIRED
ZERO_COST_SATELLITE_GATE=PASS_REQUIRED
SATELLITE_ATTRIBUTION_VISIBLE=PASS_REQUIRED
PROVIDER_FAILURE_EXPLICIT=PASS_REQUIRED
DEPLOY=NO
MERGE=NO
```
