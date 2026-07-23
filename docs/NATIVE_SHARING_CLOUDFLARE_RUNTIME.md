# Native Sharing Cloudflare Runtime

## Scope

This phase ports STRACKER native location sharing to a code-only Cloudflare architecture:

```text
Browser
→ stateless Worker gateway
→ one NativeSharingDurableObject per SESSION_ID
→ private SQLite database attached to that object
→ Static Assets for the existing frontend
```

It creates no live Worker, namespace, route, DNS record, Access application, IdP, secret, Version or Deployment. Google remains disabled.

## Boundary

The Worker validates exact paths and methods, same-origin requests, JSON content type, bounded bodies, identifiers and authorization material before calling a Durable Object. Unknown bindings, timeouts, storage faults and quota exhaustion return sanitized fail-closed errors with `no-store`.

The Worker routes every operation with `NATIVE_SHARING.getByName(sessionId)`. A viewer capability contains the non-secret session ID and is exchanged once after explicit confirmation. Subsequent reads use a short-lived opaque viewer session.

## Static Assets

`wrangler.jsonc` uses the Static Assets binding and runs the Worker first only for `/api/share/*`. `workers_dev` and preview URLs are disabled. The configuration has no route, custom domain, account identifier or real secret.

## Validation-only commands

```text
wrangler types
wrangler deploy --dry-run
```

A real Version upload or Deployment is prohibited in this phase.
