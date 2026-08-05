# STRACKER cookie-session recovery v1

## Scope

The Google Maps cookie-session path is an explicit owner-only recovery surface inside **UBICACIÓN COMPARTIDA**. It does not replace STRACKER native sharing and does not create a public viewer capability.

## Security contract

- Cookie values are accepted only by `POST /api/cookie-sessions` over the same STRACKER origin.
- Accepted input formats: Cookie Editor JSON, wrapped JSON, name/value JSON, Cookie Header and Netscape.
- Only `google.com` cookie domains are accepted.
- A successful import requires an upstream Google Location Sharing probe. Parsing alone never produces success.
- Raw cookies exist only in the memory of one Durable Object instance. They are not written to SQLite, browser storage, URLs, logs or artifacts.
- The browser keeps only a random session ID and owner token in React memory.
- `/status` exposes metadata only. Coordinates are available only from the separate owner-authorized `/point` endpoint.
- Delete, source change, page exit, expiry, auth expiry or runtime eviction revoke the usable session. Eviction/restart requires re-import.
- Import is body-bounded, same-origin, method/path allowlisted, time-bounded and best-effort rate-limited by the public Worker.

## Public API

```text
POST   /api/cookie-sessions
GET    /api/cookie-sessions/:sessionId/status
GET    /api/cookie-sessions/:sessionId/point
POST   /api/cookie-sessions/:sessionId/refresh
DELETE /api/cookie-sessions/:sessionId
```

All owner operations require `X-Stracker-Cookie-Owner`. Error bodies are sanitized `{status:"error",error:"CODE"}` responses with `Cache-Control: no-store`.

## Automation boundary

Automation uses synthetic cookie-shaped values and injected provider outcomes only. It verifies parsing, rejection, no fake success, memory-only replacement, gateway allowlists, metadata-only status, explicit deletion, mobile/desktop layout and absence of values in the DOM. Real cookie validation remains a human gate and must never be pasted into issues, PRs, logs, screenshots or artifacts.
