# STRACKER Mobile Product V1

## Product source model

`LocationSource` is strictly `my-device` or `google-shared`. Snapshots without a source are rejected by TypeScript contracts. The UI never renders data from both sources in one active map state.

## My location

Uses `navigator.geolocation.watchPosition()` only after an explicit button press. Coordinates remain in browser memory and are not persisted or uploaded by default. Background tracking is not promised.

## Shared location

Google does not expose a documented general-purpose Location Sharing consumption API for STRACKER. The honest product wording is **Vincular sesión de Google Maps**. The backend accepts Cookie Editor JSON, wrapped JSON, Cookie Header String and Netscape; normalizes allowed Google domains; checks critical cookie names; performs a real upstream probe; and stores atomically only after a valid or valid-without-location classification.

## Build

Canonical package manager: Bun 1.3.4 with `bun.lock`. Release gates use `bun install --frozen-lockfile`, lint, independent typecheck and static export build. The legacy Next.js API routes were removed because the canonical backend is Python behind a future gateway; retaining executable Next API routes made static export non-reproducible and duplicated backend authority.

## Legacy exclusion

`src/components/tracker/**` is retained only as non-executable legacy reference during gradual migration. It is excluded narrowly from the mobile V1 lint/typecheck graph because the root product no longer imports it. Removal/refactor remains a follow-up task.

## Security

The browser never receives Google cookie values or the Render service token. A future non-production Cloudflare gateway will attach `X-Stracker-Service-Token` server-side. No deployment is included in this branch.
