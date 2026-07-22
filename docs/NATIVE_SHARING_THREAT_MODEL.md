# STRACKER — Native Sharing Threat Model

## Security objective

A viewer may read only a currently valid session for which it possesses the active viewer capability. An emitter may publish, rotate or revoke only with the independent emitter capability. No observation is accepted solely because the client labels it valid.

## Trust boundaries

```text
Emitter browser
→ untrusted network
→ native HTTP boundary
→ NativeSharingService
→ NativeSharingStore

Viewer browser
→ untrusted network
→ native HTTP boundary
→ NativeSharingService
→ sanitized point response
→ existing STRACKER location pipeline
```

Map providers are a separate boundary and receive ordinary tile/style requests derived from the viewport. They never receive emitter or viewer capabilities.

## Assets

- current and historical coordinates;
- emitter capability;
- viewer capability;
- session identifier and expiration;
- sequence and timing integrity;
- revocation and rotation state;
- confirmed GhostRail segments.

## Threats and controls

### IDOR and session enumeration

Threat: changing a session identifier reveals whether another session exists or returns its data.

Controls:

- 256-bit random session identifiers;
- strict fixed-length path parser;
- possession of the correct emitter or viewer capability is also required;
- unknown session and wrong capability return the same `404 NOT_FOUND` envelope;
- no list or search endpoint exists;
- query parameters and client-selected upstreams are rejected.

### Capability guessing

Threat: brute-force discovery of emitter or viewer access.

Controls:

- independently generated 256-bit values;
- rate limits by operation and session;
- verifier-only storage;
- no capability prefix, counter or derivation relationship;
- no capability logging or artifact retention.

### Viewer capability leak

Threat: a copied or observed viewer link grants reading access.

Controls:

- viewer capability grants read-only access;
- it cannot publish, rotate or revoke;
- bounded session duration and retention;
- immediate viewer rotation invalidates the old link;
- immediate session revocation stops reads;
- the UI labels the URL as a private link and does not claim user identity.

Residual risk: anyone possessing an active viewer link can use it. This is inherent to capability links and must remain explicit.

### Emitter capability leak

Threat: an attacker publishes false points or revokes/rotates the session.

Controls:

- emitter capability never appears in URL, link text, logs or artifacts;
- it is held only in emitter document memory;
- it is sent only in the emitter header;
- viewer responses never include it;
- storage holds only its verifier;
- closing/reloading the document loses emitter control unless a future secure recovery design is added.

### Replay and sequence rollback

Threat: reuse of accepted requests or old points.

Controls:

- positive integer sequence;
- strict monotonic sequence per session;
- captured timestamp must advance;
- store append uses expected previous sequence to detect concurrent races;
- duplicate, rollback and timestamp replay are rejected.

### Fake points and timestamp manipulation

Threat: the emitter supplies arbitrary but syntactically valid observations.

Controls:

- latitude/longitude, accuracy, speed and heading bounds;
- bounded future skew and maximum age;
- minimum publication interval;
- impossible inter-point speed rejection;
- server-generated `receivedAt`, session identity and acceptance state;
- no client-provided acceptance or freshness state is trusted.

Residual risk: a compromised emitter browser can provide plausible fabricated points within physical bounds. Native V1 does not provide hardware attestation and must not claim it does.

### CSRF and open CORS

Threat: another origin causes publication, rotation or revocation.

Controls:

- no permissive CORS headers;
- explicit mismatched `Origin` rejection;
- no cookies are used for emitter/viewer authority;
- capabilities are required in explicit headers;
- `OPTIONS` does not authorize methods;
- JSON-only mutation bodies.

### XSS

Threat: injected script steals capabilities from document memory or URL.

Controls:

- capability values are never inserted as HTML;
- React text/input escaping is used;
- API errors are generic and not reflected from request data;
- strict Content-Type responses and `X-Content-Type-Options: nosniff`;
- future deployment must preserve a restrictive CSP and prohibit third-party scripts on emitter/viewer pages.

Residual risk: an application-origin XSS can access in-memory capabilities. CSP and dependency review remain release requirements for live deployment.

### Rate abuse and storage exhaustion

Threat: session creation, publication or viewer polling consumes limits.

Controls:

- operation-specific rate limits;
- 16 KiB body limit;
- store timeout;
- hard point and session-duration limits;
- bounded response points and GhostRail segments;
- no WebSocket or unbounded stream;
- expiry cleanup contract.

### Revocation race

Threat: publication or read succeeds after revocation because concurrent operations observe stale state.

Controls:

- all service operations re-read current session state;
- future live storage must provide per-session serialized writes;
- append includes expected last sequence;
- viewer rotation replaces the verifier atomically at the store boundary;
- revocation changes the authoritative session state before subsequent operations.

This is a principal reason Durable Objects are preferred for a future live adapter.

### Late responses

Threat: an aborted viewer request updates UI after changing source or closing the viewer.

Controls:

- AbortController per request;
- generation counter incremented on stop/change;
- every response checks generation and abort state;
- stop clears polling, freshness timers, snapshot, buffers and GhostRail.

### Stale shown as live

Threat: old points are displayed as current.

Controls:

- captured and received timestamps remain separate;
- existing freshness classifier derives fresh/stale/expired;
- viewer status may be stale independently of source health;
- UI visibly labels stale and never uses a fabricated `LIVE` state;
- no interpolation is performed.

### Storage compromise

Threat: storage contents reveal authority or complete location history.

Controls in this PoC:

- emitter/viewer tokens are not stored, only verifiers;
- retention is bounded;
- response sizes are bounded;
- no real storage or data is used.

Required before live deployment:

- encrypt coordinate payloads at rest with a key outside the database;
- document key rotation and recovery;
- restrict operator access;
- verify deletion behavior and backups;
- validate storage export/artifact sanitization.

### Logs and artifacts

Threat: capabilities or coordinates leak through CI, logs or diagnostics.

Controls:

- code does not log request bodies or capability headers;
- errors do not echo tokens, paths or points;
- browser QA marks all data synthetic and artifacts as coordinate-values-not-retained;
- security scans reject cookie material, bearer values, private keys, `.env` and source archives;
- artifacts contain only allowlisted sanitized reports and hashes.

### Multiple viewers

Threat: several viewers race reads, amplify traffic or infer one another.

Controls:

- viewers are read-only and share no client state;
- no viewer list, count or identity is exposed;
- polling is bounded;
- rotation invalidates all holders of the prior capability simultaneously.

Residual limitation: V1 cannot revoke a single viewer without rotating the common viewer link.

### Background suspension

Threat: users believe transmission continues while the browser is suspended or closed.

Controls:

- explicit UI warning before consent;
- visibility changes mark emitter state paused;
- freshness and last update remain visible;
- no service-worker or background-tracking claim;
- viewer displays stale when updates stop.

## Abuse cases deliberately unsupported

- anonymous public broadcasting;
- searchable or enumerable sessions;
- permanent location history;
- third-party embeds;
- wildcard CORS;
- tracking without explicit emitter action;
- viewer auto-open on link receipt;
- recovery of emitter authority from URL or browser persistence;
- Google cookies or Google accounts in the native provider.

## Validation status

The PoC validates these controls with synthetic data and in-memory storage. Live infrastructure, platform rate limiting, at-rest coordinate encryption and physical-device background behavior remain pending and cannot be marked PASS in this phase.
