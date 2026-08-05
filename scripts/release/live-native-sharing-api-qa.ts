export {}

await import(new URL(`file://${process.cwd()}/scripts/release/install-pmtiles-query-fetch-shim.ts`).href)
await import(new URL(`file://${process.cwd()}/scripts/release/live-native-sharing-api-qa-runner.ts`).href)
