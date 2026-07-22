# Zero-cost Cloudflare runtime PoC

## Scope

```text
STACK_BASE_BRANCH=feat/stracker-vector-map-engine-v1
STACK_BASE_SHA=8a3ac8d750b107e24f5ce744f15a0bbae9767f1f
BRANCH=feat/stracker-zero-cost-cloudflare-runtime-poc
PRODUCTION_DEPLOY=NO
DNS_CHANGE=NO
REAL_SECRETS=NO
REAL_GOOGLE_SESSION=NO
REAL_LOCATION_DATA=NO
```

## Architecture

```text
Browser
→ Cloudflare Access with Google identity provider
→ TypeScript Worker
   ├─ Static Assets: exported STRACKER frontend
   ├─ Web Crypto: AES-256-GCM session encryption
   ├─ D1: encrypted per-identity session persistence
   └─ fixed server-side Google Maps Location Sharing probe
```

Cloudflare Access identity, Google Maps session and the legacy/internal STRACKER service token remain separate.

## D1 versus Durable Objects

### D1 selected

D1 is selected for this PoC because the required state is a small relational record keyed by a hash of the Access subject. The workload does not require per-entity WebSockets, alarms, strong in-memory coordination or serialized multi-client state transitions.

Benefits for this scope:

- SQLite schema and explicit migration;
- one encrypted session row per Access subject;
- transactional upsert/delete semantics;
- Free-plan quota failures stop operations rather than creating paid overage;
- easier export, audit and migration than an object-per-user runtime;
- no always-on capacity charge.

### Durable Objects not selected

SQLite-backed Durable Objects are technically available on the Workers Free plan, but their main advantage is coordinated stateful execution. STRACKER does not need that capability for session linkage or spaced polling. Selecting Durable Objects here would add class migrations and routing complexity without a product requirement.

Re-evaluate Durable Objects only if STRACKER later requires per-user coordination, WebSockets, alarms or concurrency serialization.

## Storage model

```sql
shared_sessions(
  subject_hash PRIMARY KEY,
  iv_b64,
  ciphertext_b64,
  created_at,
  updated_at
)
```

`subject_hash` is SHA-256 of the Cloudflare Access `sub`. The stored plaintext is the normalized Google Maps cookie set, encrypted with AES-GCM using a 96-bit random IV and additional authenticated data bound to the hashed subject. `SESSION_ENCRYPTION_KEY` is a secret binding and is never placed in `wrangler.jsonc`.

## HTTP and parser parity

The TypeScript runtime accepts Cookie Editor JSON, wrapped JSON, Cookie Header String and Netscape formats. It enforces Google-domain allowlisting, deduplication, expiry filtering, critical-cookie checks, bounded request/response sizes and a fixed upstream URL.

The Google response parser supports the two coordinate shapes used by the Python backend, remote timestamps, accuracy, battery and charging where present. Tests use synthetic coordinates and synthetic cookie values only.

## Static Assets

`runtime/wrangler.jsonc` binds `../out` as `ASSETS`. Only `/api/*` and `/points` run the Worker first. Ordinary asset requests remain asset-first. No live upload or deployment is performed.

## Zero-cost boundary

```text
RECURRING_INFRASTRUCTURE_COST_USD=0
PAID_OVERAGE_ALLOWED=NO
AUTOMATIC_UPGRADE_TO_PAID=NO
BILLING_DEPENDENCY=NO
WORKERS_PLAN=FREE_REQUIRED
D1_PLAN=FREE_REQUIRED
FAIL_MODE=FAIL_CLOSED_REQUIRED
```

The PoC is eligible only while the account remains on Workers Free. Exceeding Workers or D1 Free quotas must fail requests or database operations. Upgrading to Workers Paid is explicitly outside automation and requires separate authorization.

## Rollback

This branch creates no infrastructure and carries no production traffic. Code rollback is branch/PR abandonment. A future live rollback must restore the previous Worker deployment and separately preserve or explicitly delete D1 state; code rollback does not revert persistent storage.

## Known risks

- Google Location Sharing is undocumented and can change without notice.
- Imported browser sessions are highly sensitive and require secret rotation and access controls.
- Free-plan CPU and request limits may be too low if parsing or traffic grows.
- Public map providers remain external processors of ordinary tile request metadata.
- D1 binding, Access application and Google IdP remain unverified until separately authorized live infrastructure exists.
