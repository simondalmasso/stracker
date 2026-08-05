export {}

await import(new URL(`file://${process.cwd()}/scripts/release/install-pmtiles-query-fetch-shim.ts`).href)
await import(new URL(`file://${process.cwd()}/scripts/release/santa-fe-affinity-canary-qa-core.ts`).href)
