# STRACKER — Sharing Provider Architecture

## Canonical product model

```text
ROOT
├── MI UBICACIÓN
└── UBICACIÓN COMPARTIDA
    ├── ABRIR ENLACE STRACKER
    ├── COMPARTIR MI UBICACIÓN
    └── GOOGLE MAPS — EXPERIMENTAL [disabled]
```

There is no third root source. `UBICACIÓN COMPARTIDA` is one isolated source whose transport is selected by a provider.

```ts
type LocationSource =
  | 'my-device'
  | 'shared-location'

type SharedLocationProvider =
  | 'stracker-native'
  | 'google-session-experimental'
```

## Provider contract

A sharing provider may produce confirmed `LocationSample` objects only after its own authorization and validation flow. It may not own or duplicate:

- MapLibre renderer;
- map modes;
- accuracy filtering;
- motion classification;
- freshness classification;
- source health;
- GhostRail rules;
- camera state;
- manual mode;
- attribution surface.

The provider boundary ends before the canonical location pipeline:

```text
provider transport
→ confirmed source-tagged sample
→ canonical location pipeline
→ canonical map adapter
```

## Native provider

```text
Emitter browser
→ explicit geolocation consent
→ native session creation
→ emitter capability
→ validated sequential point publications
→ NativeSharingStore

Viewer private link
→ explicit viewer confirmation
→ viewer capability validation
→ sanitized confirmed points
→ shared-location pipeline
→ MapLibre
```

The emitter and viewer have independent controls and no shared browser state.

## Google experimental provider

```text
provider=google-session-experimental
status=disabled
release dependency=no
```

PR #7 is retained as an experimental technical spike only:

```text
EXPERIMENTAL_GOOGLE_RUNTIME_SPIKE
NOT_RELEASE_DEPENDENCY
NOT_PRODUCTION_CANDIDATE
NO_LIVE_INFRASTRUCTURE
NO_MERGE
NO_DEPLOY
```

This branch does not import, merge or cherry-pick PR #7. It contains no Google session UI, cookie parser, Google RPC client or Google identity dependency.

A future stacked experimental phase may audit and selectively reimplement reusable Google-specific pieces. It must not modify the native provider contract or make Google a release dependency.

## Isolation requirements

Every provider/source transition must:

```text
stop watcher
stop polling
abort requests
increment generation guard
cancel timers and animations
clear snapshot
clear stable coordinate
clear accuracy filter
clear motion buffer
clear GhostRail
clear timestamps
reset camera
reject late responses
```

`my-device`, `stracker-native` and any future `google-session-experimental` provider never share observation buffers, session authority, capabilities, timestamps or GhostRail segments.

## Route ownership

```text
/                         root source selector
/share                    native emitter
/shared/<capability>       native viewer confirmation and map
/api/share/sessions...     native HTTP PoC contract
```

The viewer route is inert before confirmation. Merely receiving or opening the link does not validate the capability, request points or mount the map.

## Map invariants

The shared native provider reuses PR #6:

```text
RENDERER=MapLibre GL JS
BASEMAP_MODES=MAPA 3D|SATÉLITE|HÍBRIDO
SECOND_RENDERER=ABSENT
```

Switching basemap modes:

- does not change source or provider;
- does not recreate the map canvas;
- does not restart polling;
- does not request geolocation;
- preserves marker and segmented GhostRail;
- preserves manual camera mode;
- does not convert stale data to fresh.

## Privacy surfaces

Native sharing sends coordinates only to the native session endpoint after explicit emitter action. Map providers receive viewport-derived tile requests after the viewer explicitly opens the map. Capabilities are not sent to map providers.

```text
EMITTER_TOKEN_IN_URL=NO
VIEWER_TOKEN_IN_MAP_REQUEST=NO
CAPABILITY_IN_LOGS=NO
GOOGLE_REQUESTS=NO
```

## Deployment posture

This document defines code architecture only. No Worker, D1 database, Durable Object, Access application, Version, Deployment, route, DNS record or secret exists as a result of this phase.
