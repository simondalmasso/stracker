# STRACKER — Current State

## Canonical baseline

```text
P0_BRANCH=fix/stracker-p0-security-canonical-state
P0_HEAD_SHA=fa919edad57937481f97e74ac96f09697bf03642
MOBILE_BRANCH=feat/stracker-mobile-session-product-v1
MOBILE_HEAD_SHA=166bf8e316cabd4806ade4fb4c21a20d2ad2040a
STACK_BASE_BRANCH=feat/stracker-cloudflare-private-gateway-poc
EXPECTED_STACK_BASE_SHA=77a937b4b157c2ec2c47940d6fe6891cf10b74c9
VERIFIED_STACK_BASE_SHA=77a937b4b157c2ec2c47940d6fe6891cf10b74c9
STACK_BASE_DEVIATION=NO
CURRENT_BRANCH=feat/stracker-vector-map-engine-v1
CURRENT_HEAD_SHA=SEE_DRAFT_PR_6_HEAD
LAST_VALIDATED_IMPLEMENTATION_HEAD=a5060ca3c4cbf7fa21bd7d93689c381300a41cd3
LAST_VALIDATED_WORKFLOW_RUN=29882828366
LAST_VALIDATED_WORKFLOW_CONCLUSION=success
PR_BASE=feat/stracker-cloudflare-private-gateway-poc
DRAFT_PR=6
PRODUCTION_MODIFIED=NO
DEPLOYMENT_EXECUTED=NO
MERGE_EXECUTED=NO
PRODUCTION_TRAFFIC=0%
```

PR #1, PR #2 and PR #4 remain frozen and unmodified.

## Product entry contract

Every open, reload, new tab and navigation to `/` begins at:

```text
¿QUÉ UBICACIÓN QUERÉS VER?
MI UBICACIÓN | UBICACIÓN COMPARTIDA
```

Selection is memory-only. Before choosing a source:

```text
MAP_REQUEST=NO
LOCATION_REQUEST=NO
SESSION_REQUEST=NO
POINTS_REQUEST=NO
```

## Renderer and basemap modes

```text
RENDERER=MapLibre GL JS
DEFAULT_BASEMAP_MODE=vector-3d
BASEMAP_MODES=vector-3d|satellite|hybrid
UI_LABELS=MAPA 3D|SATÉLITE|HÍBRIDO
SECOND_RENDERER=ABSENT
```

```ts
type BasemapMode = 'vector-3d' | 'satellite' | 'hybrid'
```

`BasemapMode` is independent from `LocationSource`, `MotionState`, `FreshnessState`, `SourceHealth`, `SharedSessionState` and `CameraMode`. It exists only in document memory and is not persisted in localStorage, cookies, backend state or URL parameters.

### VECTOR_3D

```text
STYLE_PROVIDER=OpenFreeMap
BASE_DATA=OpenStreetMap/OpenMapTiles-compatible
STYLE=https://tiles.openfreemap.org/styles/liberty
BUILDINGS_3D=OPTIONAL
```

### SATELLITE and HYBRID

```text
SATELLITE_PROVIDER=eox-s2cloudless-2016
WMTS_LAYER=s2cloudless_3857
TILE_ENDPOINT=https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg
LICENSE=CC BY 4.0
IMAGERY_PERIOD=2016-2017 mosaic
RESOLUTION=10 m
MAX_ZOOM=14
RECENT_CLAIM_ALLOWED=NO
COMPLETE_COVERAGE_CLAIMED=NO
```

`SATELLITE` shows raster imagery without vector labels or extruded buildings. `HYBRID` adds OpenFreeMap line and symbol layers. The raster is inserted above the opaque vector background and below STRACKER product layers.

Accuracy, marker, connection halo, segmented GhostRail, status overlays and dynamic attribution remain above every basemap.

## Provider decision

```text
IGN_ARGENMAP_HYBRID=BLOCKED_BY_IMAGERY_PROVENANCE_AND_LICENSE_AMBIGUITY
IGN_PUBLIC_ORTHOMOSAICS=PARTIAL_COVERAGE_CANDIDATE_NOT_SELECTED
EOXCLOUDLESS_2016=SELECTED_AS_AUTHORIZED_OPEN_FALLBACK
```

No Google Satellite, Mapbox Satellite, authenticated or billable ArcGIS imagery, billable MapTiler imagery, private API or reverse-engineered endpoint is used. STRACKER does not describe EOxCloudless as recent imagery and does not claim complete IGN orthomosaic coverage.

## Zero-cost policy

```text
RECURRING_INFRASTRUCTURE_COST_USD=0
MAP_PROVIDER_COST_USD=0
PAID_OVERAGE_ALLOWED=NO
AUTOMATIC_UPGRADE_TO_PAID=NO
BILLING_DEPENDENCY=NO
MAP_PROVIDER_TOKEN=NONE
```

## Basemap transition invariants

Switching modes does not:

- change location source;
- reopen the source selector;
- request geolocation again;
- call session routes or restart polling;
- clear marker or GhostRail;
- alter accepted timestamps;
- exit manual camera mode;
- accept stale responses;
- recreate the MapLibre canvas.

The raster source and layer are added once. Mode changes alter layer visibility inside the existing MapLibre instance.

## Failure behavior

A raster-provider error or bounded availability failure produces:

```text
SATÉLITE NO DISPONIBLE EN ESTA ZONA
```

Location tracking and product overlays remain active. There is no silent fallback to a paid or unauthorized provider.

## Camera, GhostRail and source isolation

```text
unknown → overview
moving → follow
stationary → stationary
user interaction → manual
```

Manual mode blocks automatic recentering, pitch and bearing changes. Basemap changes preserve manual mode. Satellite automatic pitch is capped to reduce raster deformation. GhostRail remains segmented and bounded to 600 accepted points.

`MI UBICACIÓN` starts `watchPosition()` only after explicit user action and never calls shared-session APIs. `UBICACIÓN COMPARTIDA` uses remote timestamps without interpolation, invalidates late responses and does not restart polling during basemap changes.

## Attribution and privacy

```text
VECTOR_3D=OpenFreeMap|OpenMapTiles|OpenStreetMap
SATELLITE=EOxCloudless|EOX|modified Copernicus Sentinel data 2016 & 2017
HYBRID=SATELLITE attribution + OpenFreeMap/OpenStreetMap
```

Attribution remains visible above the bottom sheet. Providers can observe ordinary HTTP metadata and viewport-derived tile coordinates. No shared-session cookie, Cloudflare Access JWT or STRACKER service token is sent to map providers.

## Exact-head evidence

The latest validated implementation head before this documentation synchronization is:

```text
VALIDATED_IMPLEMENTATION_HEAD=a5060ca3c4cbf7fa21bd7d93689c381300a41cd3
WORKFLOW_RUN_ID=29882828366
WORKFLOW_CONCLUSION=success
MOBILE_ARTIFACT_ID=8515444752
MOBILE_ARTIFACT_DIGEST=sha256:c8af9353dcfc79bb6082d8696521683e4bb5eed2aa7e0685b350256d2764b644
PROVIDER_ARTIFACT_ID=8515433788
PROVIDER_ARTIFACT_DIGEST=sha256:90cb0a618a63b638b87cee55ff09a08e3bbc7e5a7ca263de847829b398f95f4f
A22_PHYSICAL_VALIDATION=NOT_EXECUTED_ENV_BLOCKED
```

The Draft PR body records the final documentation-only head and its exact successful workflow run.

## Validation state

```text
STACKED_BASE_CHECK=PASS
FROZEN_INSTALL=PASS
BACKEND_TESTS=PASS
ESLINT=PASS
TYPECHECK=PASS
VECTOR_MAP_TESTS=PASS
STATIC_EXPORT_BUILD=PASS
FINAL_BUNDLE_SINGLE_ENGINE=PASS
UNSELECTED_ENGINE_ABSENT=PASS
VECTOR_TO_SATELLITE=PASS
SATELLITE_TO_HYBRID=PASS
HYBRID_TO_VECTOR=PASS
LOCATION_SOURCE_UNCHANGED=PASS
MARKER_PRESERVED=PASS
GHOSTRAIL_PRESERVED=PASS
CAMERA_MANUAL_PRESERVED=PASS
NO_NEW_GEOLOCATION_REQUEST=PASS
NO_NEW_SESSION_REQUEST=PASS
NO_SECOND_RENDERER=PASS
SATELLITE_ATTRIBUTION_VISIBLE=PASS
PROVIDER_FAILURE_EXPLICIT=PASS
ZERO_COST_SATELLITE_GATE=PASS
RASTER_TRANSFER_BUDGETS=PASS
OPENFREEMAP_LIVE_VALIDATION=PASS
SATELLITE_PROVIDER_LIVE_VALIDATION=PASS
SECURITY_ARTIFACT_SCAN=PASS
TEMPORARY_WORKFLOWS_REMOVED=PASS
CI_FINAL=SUCCESS
```

## Known risks

- OpenFreeMap and EOx public services have no STRACKER-controlled SLA.
- EOxCloudless is historical 10 m imagery, not a current high-resolution orthophoto.
- IGN orthomosaic coverage remains partial or variable until a coverage-aware catalogue is validated.
- OpenStreetMap building heights and footprints may be incomplete.
- Physical Samsung Galaxy A22 performance remains unverified.
- Production remains on the previous runtime because PR #6 does not deploy.
- Google Location Sharing remains undocumented and must stay fail-closed.

## Release posture

```text
PR_1_MERGE=NO
PR_2_MERGE=NO
PR_4_MERGE=NO
PR_6_MERGE=NO
PRODUCTION_DEPLOY=NO
FULL_CLOUDFLARE_CUTOVER=NO_GO
```

## Next exact phase

Freeze PR #6 after its final documentation-only head is green. Continue the separately authorized zero-cost Cloudflare runtime PoC without merging or deploying this PR.
