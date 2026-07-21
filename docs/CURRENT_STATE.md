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
PR_BASE=feat/stracker-cloudflare-private-gateway-poc
DRAFT_PR=6
PRODUCTION_MODIFIED=NO
DEPLOYMENT_EXECUTED=NO
MERGE_EXECUTED=NO
PRODUCTION_TRAFFIC=0%
```

## Frozen pull requests

```text
PR_1=FROZEN_UNMODIFIED
PR_2=FROZEN_UNMODIFIED
PR_4=FROZEN_UNMODIFIED
```

No commit, body, base, Draft state, merge or deployment mutation was made to those pull requests during this phase.

## Product model

Every new page load, reload, new tab and navigation to `/` begins at:

```text
¿QUÉ UBICACIÓN QUERÉS VER?
MI UBICACIÓN | UBICACIÓN COMPARTIDA
```

Selection is React memory only. It is not persisted. The selector is not reopened by re-render, orientation change, visibility change, background recovery, bottom-sheet interaction or WebGL restoration.

Before selection:

```text
MAP_REQUEST=NO
LOCATION_REQUEST=NO
SESSION_REQUEST=NO
POINTS_REQUEST=NO
```

## Selected map stack

```text
RENDERER=MapLibre GL JS
STYLE_PROVIDER=OpenFreeMap
BASE_DATA=OpenStreetMap/OpenMapTiles-compatible
STYLE=https://tiles.openfreemap.org/styles/liberty
MAP_PROVIDER_TOKEN=NONE
MAP_PROVIDER_BILLING_ACCOUNT=NONE
MAPBOX_RUNTIME=ABSENT
LEAFLET_RUNTIME=ABSENT
```

Mapbox is benchmark-only. Its package is installed transiently under `/tmp` in the isolated renderer-spike job and never enters `package.json`, `bun.lock`, source runtime or exported assets.

## Zero-cost decision

```text
RECURRING_INFRASTRUCTURE_COST_USD=0
MAP_PROVIDER_COST_USD=0
PAID_OVERAGE_ALLOWED=NO
AUTOMATIC_UPGRADE_TO_PAID=NO
BILLING_DEPENDENCY=NO
ZERO_COST_HARD_GATE=PASS
PAID_OVERAGE_RISK=NO
```

Mapbox fails the strict production eligibility gate because its normal hosted service has a metered billing path after included usage and does not satisfy the required pre-charge hard-cap condition. OpenFreeMap is selected with explicit availability/no-SLA risk and an adapter path toward self-hosted compatible data or PMTiles.

## Architecture

```text
map engine adapter
camera controller
motion classifier
accuracy filter
source contracts
marker/accuracy/GhostRail layers
source selector
mobile bottom sheet
```

Motion, freshness, source health, shared-session state and camera mode are independent. No `dead` state or aggregate status is canonical.

## Source behavior

### MI UBICACIÓN

- starts `watchPosition()` only after explicit permission action;
- uses accuracy, plausible speed and heading evidence;
- maintains filtered stable point and segmented GhostRail in memory;
- does not call shared APIs;
- stops and clears on source change.

### UBICACIÓN COMPARTIDA

- starts status/polling only after selecting shared mode;
- requires same-origin private-gateway attestation;
- uses remote timestamps without interpolation;
- may keep movement `unknown`;
- aborts requests and invalidates late responses on source change;
- replaces the full pipeline on session replacement.

## Filtering and GhostRail

- Haversine distance and elapsed time are renderer-independent;
- dead-zone readings update precision/timestamps/freshness/health without moving the visual point;
- invalid coordinates, low accuracy, out-of-order timestamps and impossible speeds are rejected;
- rejected or stale/expired points do not extend GhostRail;
- excessive intervals, source changes and session replacement create discontinuities;
- discontinuities are represented as separate solid segments;
- GhostRail is bounded to 600 points in memory.

## Camera

```text
unknown → overview
moving → follow
stationary → stationary
user interaction → manual
```

Manual mode blocks automatic recentering and pitch/bearing changes. `RECENTRAR` exits manual and chooses the appropriate automatic mode. Reduced-motion removes automatic animation.

## Performance and WebGL

Budgets are defined in `docs/performance/VECTOR_MAP_BUDGETS.json`. Raw current-head evidence is produced by:

```text
stracker-vector-map-mobile-qa-<SHA>
stracker-vector-map-spike-<SHA>
```

WebGL fallback order:

1. reduce pitch;
2. reduce 3D density;
3. disable terrain;
4. simplify effects;
5. retain vector 2D.

```text
A22_PHYSICAL_VALIDATION=NOT_EXECUTED_ENV_BLOCKED
```

## Validation state

The newest workflow run named `STRACKER Vector Map Engine V1` associated with the current Draft PR #6 head is authoritative.

```text
STACKED_BASE_CHECK=SEE_CURRENT_HEAD_CI
FROZEN_INSTALL=SEE_CURRENT_HEAD_CI
BACKEND_TESTS=SEE_CURRENT_HEAD_CI
ESLINT=SEE_CURRENT_HEAD_CI
TYPECHECK=SEE_CURRENT_HEAD_CI
VECTOR_MAP_TESTS=SEE_CURRENT_HEAD_CI
BUILD=SEE_CURRENT_HEAD_CI
SINGLE_ENGINE_FINAL_BUNDLE=SEE_CURRENT_HEAD_CI
UNSELECTED_ENGINE_ABSENT=SEE_CURRENT_HEAD_CI
MOBILE_QA=SEE_CURRENT_HEAD_CI
RENDERER_SPIKE=SEE_CURRENT_HEAD_CI
PERFORMANCE_RAW_RESULTS_SAVED=SEE_CURRENT_HEAD_CI
CI_FINAL=SEE_CURRENT_HEAD_CI
```

## Provider privacy

The browser sends style, glyph, sprite and tile requests after map unlock. The provider/CDN can observe IP, user agent, requested resources and viewport-derived tile coordinates. No Google cookie, Access JWT or STRACKER service token is sent to the map provider.

Attribution is visible and accessible above the mobile sheet.

## Known risks

- OpenFreeMap public service has no contractual SLA and may change or become unavailable.
- OpenStreetMap building heights and footprints may be incomplete or inaccurate.
- Physical A22 performance remains unverified.
- Repository history still contains separately tracked sensitive-material risks.
- Production remains on the previous Render runtime because this PR does not deploy.
- The Google Location Sharing endpoint remains undocumented and must stay fail-closed.

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

```text
NEXT_PHASE=stracker-zero-cost-cloudflare-runtime-poc
```

That separate PR must test HTTP probing, parser equivalence, AES-GCM through Web Crypto, non-ephemeral storage, Cloudflare Free limits, fail-closed behavior and synthetic parity. It must not deploy production or use private data without separate authorization.
