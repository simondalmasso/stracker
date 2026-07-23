# STRACKER — Native Sharing Threat Model

## Security objective

A viewer may read only through a current, short-lived, server-revocable opaque viewer session issued after explicit confirmation and a one-time viewer-capability exchange. An emitter may publish, rotate or revoke only with the independent emitter capability. No point is accepted solely because the client labels it valid.

## Trust boundaries

```text
Emitter browser
→ untrusted network
→ native HTTP boundary
→ NativeSharingService
→ NativeSharingStore

Viewer browser opens /shared#v=<capability>
→ initial HTTP request contains only /shared
→ static confirmation screen
→ explicit VER UBICACIÓN
→ one-time JSON capability exchange
→ opaque viewer session in memory
→ authorized polling
→ canonical shared-location pipeline
```

Map providers are a separate boundary and receive ordinary tile/style requests derived from the viewport only after viewer confirmation. They never receive emitter capabilities, viewer capabilities or viewer-session tokens.

## Assets

- current and historical coordinates;
- emitter capability;
- viewer capability;
- opaque viewer-session token;
- session identifier, viewer generation and expiration;
- sequence and timing integrity;
- revocation and rotation state;
- confirmed GhostRail segments.

## Threats and controls

### IDOR and session enumeration

Threat: changing a session identifier reveals another session or its data.

Controls:

- 256-bit random session identifiers;
- strict fixed-length path parser for API session identifiers;
- status and points require a valid opaque viewer session bound to that sharing session;
- unknown sessions, invalid viewer capabilities and unknown viewer sessions use sanitized non-enumerating envelopes;
- no list or search endpoint;
- query parameters are rejected.

### Capability guessing

Threat: brute-force discovery of emitter or viewer authority.

Controls:

- independently generated 256-bit values;
- operation-specific rate limits;
- verifier-only storage;
- no derivation relationship or predictable prefix;
- no capability logging or artifact retention.

### Viewer capability in HTTP URL

Threat: a viewer capability leaks through server/CDN logs, history, Referer, analytics, observability or copied URLs.

Controls:

```text
ALLOWED=/shared#v=<capability>
FORBIDDEN=/shared/<capability>
FORBIDDEN=/shared?token=<capability>
```

- fragment data is not sent in the initial HTTP request;
- `/shared` is a static confirmation route;
- `Referrer-Policy: no-referrer`;
- `Cache-Control: no-store`;
- restrictive CSP;
- no analytics on shared routes;
- browser QA verifies that request URLs never contain emitter, viewer or viewer-session secrets.

Residual risk: the complete private link can still leak through user screenshots, clipboard history or deliberate forwarding. Rotation and bounded duration are the available controls.

### Viewer capability reuse

Threat: the original capability becomes a long-lived polling credential.

Controls:

- the capability is sent once in the JSON body of `POST /api/share/viewer/exchange`;
- the server compares its verifier and issues a new opaque session token;
- the browser immediately calls `history.replaceState(null, '', '/shared')`;
- the original capability variable is cleared;
- status, points and logout accept only `Authorization: Bearer <opaque-session>`;
- `X-Stracker-Viewer` is absent from the release runtime.

### Opaque viewer-session theft

Threat: an attacker obtains the in-memory viewer-session token.

Controls:

- independent random token;
- verifier-only server storage;
- ten-minute maximum TTL, capped by sharing-session expiration;
- document-memory-only client storage;
- no localStorage, sessionStorage, IndexedDB, URL or JavaScript-readable cookie;
- no token reflection in errors, DOM, logs or artifacts;
- logout, rotation and revocation invalidate it server-side.

Residual risk: same-origin XSS can access document memory. CSP, dependency review and same-origin isolation remain mandatory for live deployment.

### Rotation and revocation race

Threat: a viewer continues reading after link rotation or session revocation.

Controls:

- viewer sessions carry the sharing session's viewer generation;
- rotation increments generation and revokes all active viewer sessions;
- sharing revocation changes authoritative state and revokes all viewer sessions;
- every read checks sharing state, viewer generation, viewer-session revocation and expiration;
- frontend generation guards ignore stale responses;
- future live storage must serialize these mutations per sharing session.

### Emitter capability leak

Threat: an attacker publishes false points or rotates/revokes the session.

Controls:

- emitter capability never appears in URL, link text, logs or artifacts;
- it is kept only in emitter document memory;
- it is sent only in the emitter header;
- viewer responses never include it;
- storage holds only its verifier.

### Replay and sequence rollback

Threat: reuse of accepted requests or older points.

Controls:

- positive integer sequence;
- strict monotonic sequence per session;
- captured timestamp must advance;
- append uses expected previous sequence to detect concurrent races;
- duplicate, rollback and timestamp replay are rejected.

### Fake points and timestamp manipulation

Threat: the emitter supplies arbitrary but syntactically valid observations.

Controls:

- coordinate, accuracy, speed and heading bounds;
- bounded future skew and maximum age;
- minimum publication interval;
- impossible inter-point speed rejection;
- server-generated `receivedAt`, session identity and acceptance state;
- no client-provided freshness or acceptance state is trusted.

Residual risk: a compromised emitter can fabricate physically plausible points. Native V1 provides no hardware attestation.

### CSRF and open CORS

Threat: another origin causes publication, exchange, logout, rotation or revocation.

Controls:

- no permissive CORS headers;
- explicit mismatched `Origin` rejection;
- no authority cookie;
- explicit capability or bearer headers;
- JSON-only mutation bodies;
- `OPTIONS` does not grant authorization.

### XSS

Threat: injected script steals in-memory secrets.

Controls:

- capability values are never inserted as HTML;
- React escaping is used;
- errors are generic and do not reflect request values;
- `X-Content-Type-Options: nosniff`;
- restrictive shared-route CSP;
- no analytics or third-party script requirement on `/shared`.

### Rate abuse and storage exhaustion

Controls:

- operation-specific rate limits;
- 16 KiB body limit;
- storage timeout;
- hard session, point, response and GhostRail limits;
- no WebSocket or unbounded stream;
- bounded expiration cleanup.

### Late responses

Threat: an aborted or prior-generation request updates UI after closing or changing source.

Controls:

- AbortController per request;
- local generation incremented on stop/change;
- responses verify generation, abort state and active viewer-session reference;
- cleanup clears polling, timers, viewer authority, snapshot, filters and GhostRail;
- logout failure never blocks local cleanup.

### Stale shown as live

Controls:

- captured and received timestamps remain separate;
- canonical freshness classifier derives fresh/stale/expired;
- viewer status may be stale independently of source health;
- UI labels stale and never fabricates `LIVE`;
- no interpolation.

### Storage compromise

PoC controls:

- emitter, viewer and viewer-session tokens are stored only as verifiers;
- retention is bounded;
- no real storage or data is used.

Required before live deployment:

- encrypt coordinate payloads at rest with a key outside the database;
- document key rotation and recovery;
- restrict operator access;
- verify deletion and backup behavior;
- validate export and artifact sanitization.

### Logs, errors and artifacts

Controls:

- code does not log request bodies or authorization headers;
- errors never echo capabilities, session tokens or points;
- browser QA checks console, page errors and every request URL;
- artifacts contain only allowlisted sanitized reports and hashes;
- security gates scan source, static export, logs and artifact staging;
- synthetic token values are asserted absent before artifact upload.

### Multiple viewers

- each exchange creates an independent opaque viewer session;
- viewers share no browser state;
- no viewer list, count or identity is exposed;
- rotation invalidates all sessions from the prior generation;
- session revocation invalidates all viewer sessions.

Native V1 does not provide selective per-viewer revocation without identifying viewers; logout revokes only the presented viewer session.

### Background suspension

- explicit warning before emitter consent;
- hidden/suspended browsers may pause publication;
- freshness and last update remain visible;
- no service-worker or background-tracking claim;
- viewer becomes stale when updates stop.

## Deliberately unsupported

- anonymous public broadcasting;
- searchable sessions;
- permanent location history;
- third-party embeds;
- wildcard CORS;
- tracking without explicit emitter action;
- viewer auto-exchange on link receipt;
- viewer capabilities in path or query;
- persistent viewer authority;
- Google cookies or Google accounts in the native provider.

## Validation status

The PoC validates these controls with synthetic data and in-memory storage. Live infrastructure, platform rate limiting, at-rest coordinate encryption and physical-device background behavior remain pending and cannot be marked PASS in this phase.
