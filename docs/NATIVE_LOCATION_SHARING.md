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

The screen exposes:

```text
ESTADO
DURACIÓN RESTANTE
ÚLTIMA ACTUALIZACIÓN
DETENER
ROTAR ENLACE
REVOCAR ENLACE
```

`DETENER` clears the watcher, aborts pending requests and pauses publication without revoking the link. `REVOCAR ENLACE` immediately revokes the sharing session and all viewer sessions. Rotation replaces the viewer capability verifier, increments viewer generation and invalidates every viewer session issued under the previous generation.

The UI states that browsers may suspend geolocation or JavaScript when hidden, locked, backgrounded or closed. STRACKER does not promise continuous background tracking.

## Viewer link and inert confirmation route

The only shareable viewer URL is:

```text
/shared#v=<SESSION_ID.VIEWER_TOKEN>
```

Forbidden forms:

```text
/shared/<viewer-capability>
/shared?token=<viewer-capability>
/shared?capability=<viewer-capability>
```

The URL fragment exists only in the browser and is not part of the initial HTTP request. The static `/shared` response uses:

```text
Cache-Control: no-store
Referrer-Policy: no-referrer
Content-Security-Policy: restrictive
Permissions-Policy: geolocation=(), camera=(), microphone=()
X-Robots-Tag: noindex, nofollow, noarchive, nosnippet
ANALYTICS_ON_SHARED_ROUTES=OFF
```

Before `VER UBICACIÓN`:

```text
NO_CAPABILITY_EXCHANGE
NO_STATUS_REQUEST
NO_POINTS_REQUEST
NO_MAP_REQUEST
NO_GEOLOCATION_REQUEST
```

The fragment may be read locally only to determine whether its format is valid. It produces no network traffic.

## Capability exchange and opaque viewer session

After explicit confirmation:

```text
read window.location.hash
→ validate format and length locally
→ POST /api/share/viewer/exchange
→ send viewerCapability once in JSON body
→ compare capability verifier server-side
→ issue short-lived opaque viewer session
→ history.replaceState(null, '', '/shared')
→ clear original capability variables
→ start authorized polling
```

Exchange response:

```ts
interface ViewerExchangeResponse {
  sessionId: string
  viewerSessionToken: string
  viewerGeneration: number
  expiresAt: string
}
```

The viewer session token:

- is independently random and opaque;
- is stored only as a server-side verifier plus generation and expiration;
- remains only in document memory on the client;
- is sent through `Authorization: Bearer`;
- never enters path, query, fragment, localStorage, sessionStorage, IndexedDB or a JavaScript-readable cookie;
- never appears in errors, logs or artifacts;
- is not a stateless JWT.

Every viewer read verifies:

```text
sharing session active
viewer generation current
viewer session verifier present
viewer session not revoked
viewer session not expired
```

The original capability is exchanged once and is never reused for polling.

## Viewer cleanup

Closing, changing source, receiving an invalid/revoked/expired response or unmounting performs local cleanup regardless of logout success:

```text
abort requests
stop polling
clear timers
increment generation guard
clear viewer session token
clear session id and generation
clear snapshot and stable coordinate
clear filters and motion state
clear GhostRail
reset camera
best-effort POST /api/share/viewer/logout
```

Late responses check the local generation and active viewer-session reference before updating state. They cannot repopulate a closed or replaced viewer.

## Capability model

Each sharing session receives three independently generated 256-bit random values:

```text
SESSION_ID
EMITTER_TOKEN
VIEWER_TOKEN
```

A successful exchange creates a fourth independent value:

```text
OPAQUE_VIEWER_SESSION_TOKEN
```

Rules:

- values are generated independently with Web Crypto;
- the emitter token never appears in a URL;
- the viewer capability appears only after `#v=` in the private link;
- storage receives SHA-256 verifiers, not complete emitter, viewer or viewer-session tokens;
- invalid capability and unknown session produce the same public `404 NOT_FOUND` envelope;
- tokens are never logged or retained in artifacts;
- rotating the viewer capability replaces its verifier and increments generation;
- rotation or revocation invalidates active viewer sessions immediately;
- session identifiers are random and non-enumerable.

Capabilities authorize possession, not identity, ownership or trust.

## HTTP PoC

```text
POST   /api/share/sessions
POST   /api/share/sessions/:id/points
POST   /api/share/viewer/exchange
POST   /api/share/viewer/logout
GET    /api/share/sessions/:id/status
GET    /api/share/sessions/:id/points
POST   /api/share/sessions/:id/rotate-viewer
DELETE /api/share/sessions/:id
```

Boundary properties:

```text
JSON_ONLY=YES
CACHE_CONTROL=no-store
REFERRER_POLICY=no-referrer
BODY_LIMIT=16KiB
STORE_TIMEOUT=1500ms
STRICT_METHODS=YES
STRICT_PATHS=YES
QUERY_PARAMETERS=REJECTED
OPEN_CORS=NO
REDIRECTS=NO
SANITIZED_ERRORS=YES
```

Emitter requests use the independent emitter header. Viewer polling and logout use only the opaque viewer-session bearer. `X-Stracker-Viewer` is not part of the release runtime.

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

Server acceptance validates contract version, monotonic positive sequence, replay, timestamps, frequency, coordinates, accuracy, speed, heading, retention, impossible jumps and concurrent sequence races. A client declaration never bypasses server checks.

## Retention

```text
MAX_SESSION_DURATION=4h
DEFAULT_SESSION_DURATION=1h
MIN_SESSION_DURATION=5m
VIEWER_SESSION_TTL=10m, capped by sharing-session expiration
MAX_POINTS_PER_SESSION=2880
MIN_POINT_INTERVAL=5s
MAX_GHOSTRAIL_SEGMENTS=64
MAX_POINTS_PER_RESPONSE=600
EXPIRATION_GRACE=60s
DELETE_AFTER_EXPIRATION=24h
```

Expired or revoked sessions stop accepting emitter publications and viewer reads immediately. Expired records are candidates for physical deletion after the bounded cleanup delay; no indefinite location retention is part of this contract.

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

No second renderer or provider-specific classifier is added.

## Validation boundary

All tests use in-memory storage, synthetic capabilities and synthetic coordinates. Browser QA inspects request URLs, request bodies, authorization headers, storage surfaces, console errors, page errors and sanitized artifacts. No Worker, Durable Object, D1 database, Version, Deployment, route, DNS change or secret is created.
