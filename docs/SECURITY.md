# STRACKER Security Model

## Data classification

Locations, trajectories, timestamps, device telemetry and Google session cookies are highly sensitive. They must not be public, cached, logged verbatim or committed to Git.

## Source isolation

```text
LocationSource = my-device | google-shared
```

The two sources share only the renderer adapter and visual component contracts. They do not share watchers, polling, requests, buffers, timestamps, stable coordinates, motion state, GhostRail or shared-session state.

Changing source:

1. invalidates the current generation;
2. stops the device watcher and timers;
3. aborts shared requests and polling;
4. clears marker, accuracy, GhostRail and pipeline state;
5. destroys the MapLibre instance and camera animation state;
6. prevents late callbacks or responses from repopulating the prior source.

## Canonical source selection

The source selector appears on every new page load, reload and navigation to `/`. Selection exists only in React memory.

Before selection:

```text
MAP_REQUEST=PROHIBITED
GEOLOCATION_REQUEST=PROHIBITED
SESSION_REQUEST=PROHIBITED
POINTS_REQUEST=PROHIBITED
```

No location-source key is persisted in localStorage, cookies, IndexedDB or backend state.

## Device location

`MI UBICACIÓN` starts `navigator.geolocation.watchPosition()` only after explicit user action. Coordinates and GhostRail remain in memory by default and are not sent to the shared backend.

Map style and tile requests begin only after a real accepted device reading unlocks the map. The map provider can observe normal network metadata and viewport tile requests; STRACKER does not claim that map traffic stays only on the device.

## Shared location

`UBICACIÓN COMPARTIDA` uses same-origin private-gateway routes. Google session material is processed only by the protected backend path and is never sent to MapLibre, OpenFreeMap, OpenStreetMap or browser artifacts.

Polling uses remote timestamps without interpolation. Missing or invalid timestamps do not create a synthetic location sample. Session status, source health, freshness and motion remain separate state machines.

## Vector map boundary

```text
RENDERER=MapLibre GL JS
STYLE_PROVIDER=OpenFreeMap
BASE_DATA=OpenStreetMap/OpenMapTiles-compatible
MAPBOX_RUNTIME=ABSENT
LEAFLET_RUNTIME=ABSENT
MAP_PROVIDER_TOKEN=ABSENT
```

The map adapter accepts only already-filtered render state. It cannot import Google cookies, issue shared-session requests or classify motion.

The public OpenFreeMap service requires visible attribution and has no contractual SLA. Provider failure must degrade the map without weakening source privacy or session authentication.

## Filtering and GhostRail

- invalid coordinates, unusable accuracy, duplicate timestamps and impossible speeds are rejected;
- dead-zone readings update metadata but do not move the visual point;
- rejected points are not rendered or appended to GhostRail;
- stale or expired samples do not extend GhostRail;
- discontinuities create separate solid segments and are never connected;
- GhostRail is bounded to 600 accepted points in memory.

No module invents points, interpolation or a LIVE state.

## Camera and WebGL

Manual interaction sets `cameraMode=manual`. While manual, new source readings cannot recenter or modify bearing/pitch. `RECENTRAR` explicitly returns to follow, stationary or overview.

WebGL context loss disables 3D, reduces pitch and preserves the selected source. It does not reopen the selector or start a new watcher/session request. Reduced-motion preferences remove automatic camera animation.

## Transitional backend authentication

Protected routes require a server-configured `STRACKER_API_TOKEN` with at least 32 characters. Accepted transports:

- `Authorization: Bearer <token>` for controlled clients;
- `X-Stracker-Service-Token: <token>` for the future private gateway.

Tokens are compared with constant-time logic. Missing configuration fails closed. CORS is defense-in-depth, not authentication.

## Runtime modes

`STRACKER_ENV` accepts `development`, `test`, or `production`. Production startup fails before serving sensitive routes unless service-token and encryption requirements are satisfied.

## Static file policy

The Python server uses a fail-closed allowlist. Sensitive files, repository metadata, logs, histories, profiles and audit inputs are not public assets.

## Artifact policy

CI artifacts contain only synthetic fixtures, aggregate performance measurements, package versions and sanitized request hosts/counts. They must not contain:

- authorization headers;
- cookie values;
- Access JWTs;
- service tokens;
- Google session material;
- real location coordinates;
- screenshots containing private data.

## Manual incident actions

This PR does not rotate credentials, revoke Google sessions, rewrite Git history, change repository visibility or deploy infrastructure. Historical sensitive material remains a separately authorized remediation item.
