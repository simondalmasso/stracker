# STRACKER — Native Location Sharing V1

## Scope

This phase implements the canonical provider:

```text
emisor STRACKER
→ sesión temporal
→ publicación autorizada
→ enlace privado de espectador
→ proveedor nativo sin Google
```

It does not create or modify Cloudflare infrastructure, storage, routes, DNS, secrets, production traffic or Render.

```text
REAL_LOCATION_DATA=ABSENT
REAL_GOOGLE_REQUESTS=ABSENT
REAL_COOKIES=ABSENT
DEPLOY=NO
MERGE=NO
```

## Source and provider model

```ts
type LocationSource =
  | 'my-device'
  | 'shared-location'

type SharedLocationProvider =
  | 'stracker-native'
  | 'google-session-experimental'
```

`LocationSource` controls the isolated cartographic pipeline. `SharedLocationProvider` describes how `shared-location` receives confirmed observations. Provider selection does not merge watcher state, polling, requests, timestamps, buffers, GhostRail or camera state.

Google is present only as a disabled product marker:

```text
GOOGLE MAPS — EXPERIMENTAL
No disponible en esta versión
```

The release flow contains no Google cookie importer and makes no Google Location Sharing request.

## Root and shared entry

The root contract remains:

```text
¿QUÉ UBICACIÓN QUERÉS VER?
MI UBICACIÓN
UBICACIÓN COMPARTIDA
```

The shared hub contains:

```text
ABRIR ENLACE STRACKER
COMPARTIR MI UBICACIÓN
GOOGLE MAPS — EXPERIMENTAL [disabled]
```

The hub performs no geolocation, session, status, points or map request.

## Emitter flow

Route:

```text
/share
```

Before `INICIAR TRANSMISIÓN`:

```text
GEOLOCATION_REQUEST=NO
SESSION_CREATE_REQUEST=NO
POINT_PUBLICATION=NO
```

After explicit action:

```text
getCurrentPosition()
→ create temporary session
→ receive independent emitter/viewer capabilities
→ publish initial observation
→ start watchPosition()
→ publish bounded sequential points
```

The screen always exposes:

```text
ESTADO
DURACIÓN RESTANTE
ÚLTIMA ACTUALIZACIÓN
DETENER
ROTAR ENLACE
REVOCAR ENLACE
```

`DETENER` clears the watcher, aborts pending requests and pauses publication without revoking the existing link. `REVOCAR ENLACE` immediately changes the server session to revoked and prevents further publication and reading. Rotation invalidates the previous viewer capability.

The UI explicitly states that browsers may suspend geolocation or JavaScript when hidden, locked, backgrounded or closed. STRACKER does not promise continuous background tracking.

## Viewer flow

Route:

```text
/shared/<SESSION_ID.VIEWER_TOKEN>
```

Before `VER UBICACIÓN`:

```text
NO_STATUS_REQUEST
NO_POINTS_REQUEST
NO_MAP_REQUEST
```

After confirmation:

```text
parse capability locally
→ validate viewer capability server-side
→ read sanitized status
→ read confirmed points
→ feed existing shared-location pipeline
→ mount existing MapLibre renderer
→ start abortable polling
```

Closing or changing source aborts requests, clears timers, increments the generation guard and resets the complete shared pipeline. A late response cannot repopulate a prior source.

## Capability model

Each session receives three independently generated 256-bit random values:

```text
SESSION_ID
EMITTER_TOKEN
VIEWER_TOKEN
```

Rules:

- values are generated independently with Web Crypto;
- the emitter token never appears in a URL;
- only the viewer capability appears in the private link;
- storage receives SHA-256 verifiers, not complete emitter/viewer tokens;
- capability checks process every verifier byte before returning;
- invalid capability and unknown session produce the same public `404 NOT_FOUND` envelope;
- tokens are never written to logs or artifacts;
- rotating the viewer capability replaces its verifier and generation;
- session identifiers are random and non-enumerable.

Capabilities authorize possession of a link or emitter secret. They are not identity, ownership or trust assertions.

## HTTP PoC

```text
POST   /api/share/sessions
POST   /api/share/sessions/:id/points
GET    /api/share/sessions/:id/status
GET    /api/share/sessions/:id/points
POST   /api/share/sessions/:id/rotate-viewer
DELETE /api/share/sessions/:id
```

Boundary properties:

```text
JSON_ONLY=YES
CACHE_CONTROL=no-store
BODY_LIMIT=16KiB
STORE_TIMEOUT=1500ms
STRICT_METHODS=YES
STRICT_PATHS=YES
QUERY_PARAMETERS=REJECTED
OPEN_CORS=NO
REDIRECTS=NO
SANITIZED_ERRORS=YES
```

Emitter and viewer capabilities use separate request headers. Browser-controlled origins other than the request origin are rejected. `OPTIONS` is not an implicit cross-origin authorization mechanism.

## Point contract

```ts
interface NativeSharedLocationPoint {
  version: 1
  sequence: number
  lat: number
  lng: number
  accuracyM: number | null
  speedMps: number | null
  headingDeg: number | null
  capturedAt: string
}
```

The server adds:

```text
receivedAt
sessionId
acceptanceState=accepted
```

Server acceptance validates:

- contract version;
- monotonic positive integer sequence;
- duplicate and replay attempts;
- timestamp validity, future skew and maximum age;
- minimum interval;
- latitude and longitude bounds;
- accuracy, speed and heading bounds;
- point-count retention limit;
- impossible inter-point speed;
- concurrent sequence races.

A client declaration never bypasses server checks.

## Retention

```text
MAX_SESSION_DURATION=4h
DEFAULT_SESSION_DURATION=1h
MIN_SESSION_DURATION=5m
MAX_POINTS_PER_SESSION=2880
MIN_POINT_INTERVAL=5s
MAX_GHOSTRAIL_SEGMENTS=64
MAX_POINTS_PER_RESPONSE=600
EXPIRATION_GRACE=60s
DELETE_AFTER_EXPIRATION=24h
```

Expired or revoked sessions stop accepting emitter publications and viewer point reads immediately. Expired records are candidates for physical deletion after the bounded cleanup delay; no indefinite location retention is part of this contract.

## Map reuse

The provider feeds the unchanged PR #6 cartographic components:

```text
MapLibre GL JS
MAPA 3D
SATÉLITE
HÍBRIDO
accuracy filter
motion classifier
freshness
source health
segmented GhostRail
camera modes
manual-mode protection
late-response generation guard
```

No second renderer or provider-specific motion classifier is added.

## Validation boundary

All tests use in-memory storage, synthetic capabilities and synthetic coordinates. The HTTP layer is invoked directly or intercepted by browser QA. No Worker, Durable Object, D1 database, Version, Deployment, route or secret is created.
