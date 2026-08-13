# STRACKER cookie-session recovery v3

## Scope

The Google Maps cookie-session path is an explicit owner-only recovery surface inside **UBICACIÓN COMPARTIDA**. It does not replace STRACKER native sharing and does not create a public viewer capability.

## Persistence and security contract

- Cookie values are accepted only by `POST /api/cookie-sessions` over the same STRACKER origin.
- Accepted input includes real Cookie Editor JSON (including nullable auxiliary fields), wrapped JSON, name/value JSON, Cookie Header and Netscape.
- Only `google.com` cookie domains are accepted and a successful import requires an upstream Google Location Sharing probe.
- Raw cookie values are never written to browser storage, URLs, DOM, logs or artifacts.
- The browser may keep only the random STRACKER `sessionId`, `ownerToken` and TTL in same-tab `sessionStorage` so a reload can recover the same session. Coordinates are not stored there.
- The Durable Object stores only an owner verifier plus an AES-256-GCM encrypted payload containing the temporary cookie set and latest provider point. The owner token is not persisted server-side and is required to derive the decryption key.
- Durable Object eviction/hibernation therefore destroys only in-memory state; encrypted durable storage can reconstruct the same authorized session.
- Session TTL is STRACKER-controlled. An ancillary cookie expiring earlier does not shorten the session. The provider probe remains authoritative for real authentication failure.
- Transient provider/network/storage errors do not revoke the session. Real authentication rejection, TTL expiry, `BORRAR SESIÓN` or `DETENER` delete the encrypted record.
- The session is not revoked by tab background/foreground, pagehide/pageshow, map remount, 3D/Satélite/Híbrido switches or WebGL recovery.

## Public API

```text
POST   /api/cookie-sessions
GET    /api/cookie-sessions/:sessionId/status
GET    /api/cookie-sessions/:sessionId/point
POST   /api/cookie-sessions/:sessionId/refresh
DELETE /api/cookie-sessions/:sessionId
```

All owner operations require `X-Stracker-Cookie-Owner`. Error bodies are sanitized `{status:"error",error:"CODE"}` responses with `Cache-Control: no-store`.

## GhostRail

Cookie-provided points use the same location pipeline as other shared locations:

```text
COOKIE_LOCATION_POINT
→ LocationSample(shared-location)
→ processLocationSample
→ accuracy filter
→ GhostRail
→ MobileMapShell
```

Only accepted real points enter the rail; STRACKER does not interpolate synthetic intermediate positions.

## Automation boundary

Automation uses synthetic cookie-shaped values and injected provider outcomes only. It verifies parsing, encryption-at-rest, eviction recovery, transient/error lifecycle, GhostRail continuity, same-tab recovery and absence of credential values in DOM/log/artifacts. Real cookie validation remains a human gate and real cookie values must never be pasted into issues, PRs, logs, screenshots or artifacts.
