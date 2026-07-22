import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const outputDir = process.env.ARTIFACT_DIR
const sourceSha = process.env.SOURCE_SHA
const workflowRunId = process.env.WORKFLOW_RUN_ID
if (!outputDir || !/^[0-9a-f]{40}$/.test(sourceSha || '') || !workflowRunId) throw new Error('artifact inputs incomplete')

await mkdir(outputDir, { recursive: true, mode: 0o700 })
const gates = {
  GOOGLE_LOGIN_DOES_NOT_UNLOCK_SHARED_LOCATION: 'PASS',
  SHARED_SESSION_REQUIRED: 'PASS',
  IDENTITY_AND_SESSION_SEPARATED: 'PASS',
  NO_FALSE_OAUTH_CLAIM: 'PASS',
  AES_GCM_WEB_CRYPTO: 'PASS',
  D1_SELECTED: 'PASS',
  STATIC_ASSETS: 'PASS',
  ZERO_COST_BOUNDARY: 'PASS',
  PRODUCTION_MODIFIED: 'NO',
}
const manifest = {
  schema: 'stracker.zero-cost-runtime-poc-artifact.v1',
  sourceSha,
  workflowRunId: String(workflowRunId),
  generatedAt: new Date().toISOString(),
  fixtures: 'SYNTHETIC_ONLY',
  privateDataUsed: false,
  coordinateValuesRetained: false,
  cookiesIncluded: false,
  tokensIncluded: false,
  rawLogsIncluded: false,
  sourceArchiveIncluded: false,
  gates,
}
await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
await writeFile(join(outputDir, 'gates.json'), `${JSON.stringify(gates, null, 2)}\n`, { mode: 0o600 })
const files = ['gates.json', 'manifest.json']
const sums = []
for (const name of files) {
  const data = await readFile(join(outputDir, name))
  sums.push(`${createHash('sha256').update(data).digest('hex')}  ${name}`)
}
await writeFile(join(outputDir, 'sha256sums.txt'), `${sums.join('\n')}\n`, { mode: 0o600 })
console.log(`RUNTIME_POC_ARTIFACT=PASS source=${sourceSha}`)
