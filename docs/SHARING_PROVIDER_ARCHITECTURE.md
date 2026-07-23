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

Emitter:

```text
explicit geolocation consent
→ native session creation
→ emitter capability in document memory
→ validated sequential point publications
→ NativeSharingStore
```

Viewer:

```text
/shared#v=<viewer-capability>
→ initial HTTP request contains only /shared
→ static inert confirmation screen
→ explicit VER UBICACIÓN
→ one-time POST /api/share/viewer/exchange
→ opaque short-lived viewer session
→ fragment removed
→ authorized polling
→ shared-location pipeline
→ MapLibre
```

The emitter and viewer have independent controls and no shared browser state.

## Viewer authority layers

```text
VIEWER_CAPABILITY
!=
OPAQUE_VIEWER_SESSION
!=
EMITTER_CAPABILITY
```

The viewer capability:

- exists only after `#v=`;
- is never in HTTP path or query;
- is sent once in the exchange JSON body after confirmation;
- is cleared from browser state after exchange.

The opaque viewer session:

- is independently generated;
- is stored server-side as a verifier, generation and expiration;
- remains only in viewer document memory;
- is sent as `Authorization: Bearer`;
- is checked on every read;
- is revocable immediately;
- is invalidated by viewer-capability rotation or sharing-session revocation.

No JWT-only stateless viewer authority is used.

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
clear viewer session authority
clear snapshot
clear stable coordinate
clear accuracy filter
clear motion buffer
clear GhostRail
clear timestamps
reset camera
reject late responses
best-effort viewer logout
```

`my-device`, `stracker-native` and any future `google-session-experimental` provider never share observation buffers, session authority, capabilities, timestamps or GhostRail segments.

## Route ownership

```text
/                              root source selector
/share                         native emitter
/shared                        static native viewer confirmation and map
/shared#v=<capability>         shareable browser URL; fragment is not sent to server
/api/share/sessions...         native sharing HTTP contract
/api/share/viewer/exchange     one-time capability exchange
/api/share/viewer/logout       revoke current opaque viewer session
```

Forbidden route forms:

```text
/shared/<capability>
/shared?token=<capability>
/shared?capability=<capability>
```

The viewer route is inert before confirmation. Opening the link does not exchange authority, request status or points, mount the map or request geolocation.

## HTTP and browser security surface

Shared route requirements:

```text
Cache-Control=no-store
Referrer-Policy=no-referrer
Content-Security-Policy=restrictive
Permissions-Policy=geolocation=(), camera=(), microphone=()
ANALYTICS=OFF
ROBOTS=noindex
```

API requirements:

```text
JSON_ONLY=YES
QUERY_PARAMETERS=REJECTED
OPEN_CORS=NO
REDIRECTS=NO
SANITIZED_ERRORS=YES
CAPABILITIES_IN_LOGS=NO
CAPABILITIES_IN_ARTIFACTS=NO
```

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

Native sharing sends coordinates only to the native session endpoint after explicit emitter action. Map providers receive viewport-derived tile requests only after the viewer explicitly opens the map. No authority is sent to map providers.

```text
EMITTER_TOKEN_IN_URL=NO
VIEWER_CAPABILITY_IN_PATH=NO
VIEWER_CAPABILITY_IN_QUERY=NO
VIEWER_SESSION_TOKEN_IN_URL=NO
VIEWER_TOKEN_IN_MAP_REQUEST=NO
CAPABILITY_IN_LOGS=NO
GOOGLE_REQUESTS=NO
```

## Deployment posture

This document defines code architecture only. No Worker, D1 database, Durable Object, Access application, Version, Deployment, route, DNS record or secret exists as a result of this phase.
