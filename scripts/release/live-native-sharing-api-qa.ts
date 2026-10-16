export {}

const generatedControlledPilotQa = new URL(import.meta.url).pathname.endsWith('/pilot-api-qa.ts')
if (generatedControlledPilotQa) {
  process.env.STRACKER_DEFER_PUBLIC_3D_QA = '1'
  console.log('PUBLIC_3D_QA_DEFERRED_TO_POST_PROMOTION=YES')
}

await import(new URL(`file://${process.cwd()}/scripts/release/install-pmtiles-query-fetch-shim.ts`).href)
await import(new URL(`file://${process.cwd()}/scripts/release/live-native-sharing-api-qa-runner.ts`).href)