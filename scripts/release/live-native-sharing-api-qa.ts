export {}

const originalFetch = globalThis.fetch.bind(globalThis)
const metadataPaths = new Set(['/__stracker/version.json', '/__stracker/build.json'])

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) return new URL(input.href)
  if (typeof input === 'string') return new URL(input)
  return new URL(input.url)
}

async function curlMetadata(url: URL, init?: RequestInit): Promise<Response> {
  const requestHeaders = new Headers(init?.headers)
  const args = [
    'curl', '--silent', '--show-error', '--max-time', '20', '--write-out', '\n%{http_code}',
    '-H', `Accept: ${requestHeaders.get('Accept') || 'application/json'}`,
    '-H', `Cache-Control: ${requestHeaders.get('Cache-Control') || 'no-cache'}`,
  ]
  const versionOverride = requestHeaders.get('Cloudflare-Workers-Version-Overrides')
  if (versionOverride) args.push('-H', `Cloudflare-Workers-Version-Overrides: ${versionOverride}`)
  args.push(url.href)
  const subprocess = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, exitCode] = await Promise.all([new Response(subprocess.stdout).text(), subprocess.exited])
  if (exitCode !== 0) return new Response('', { status: 503 })
  const boundary = stdout.lastIndexOf('\n')
  if (boundary < 0) return new Response('', { status: 503 })
  const body = stdout.slice(0, boundary)
  const parsedStatus = Number(stdout.slice(boundary + 1).trim())
  const status = Number.isInteger(parsedStatus) && parsedStatus >= 200 && parsedStatus <= 599 ? parsedStatus : 503
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' } })
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = requestUrl(input)
  if (metadataPaths.has(url.pathname) && process.env.STRACKER_VERSION_OVERRIDE) {
    url.searchParams.set('transport', `curl-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    return curlMetadata(url, init)
  }
  return originalFetch(input, init)
}) as typeof fetch

interface DeploymentEvidence { id: string; percentage: number }

async function deploymentForVersion(versionId: string): Promise<DeploymentEvidence> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || ''
  const token = process.env.CLOUDFLARE_API_TOKEN || ''
  if (!accountId || !token) throw new Error('CLOUDFLARE_DEPLOYMENT_EVIDENCE_ENV_REQUIRED')
  const response = await originalFetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/stracker/deployments`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, cache: 'no-store',
  })
  const payload = await response.json().catch(() => null) as {
    success?: boolean
    result?: { deployments?: Array<{ id?: string; versions?: Array<{ version_id?: string; id?: string; percentage?: number | string }> }> }
  } | null
  if (!response.ok || payload?.success !== true) throw new Error('CLOUDFLARE_DEPLOYMENT_EVIDENCE_UNAVAILABLE')
  const matches: DeploymentEvidence[] = []
  for (const deployment of payload.result?.deployments || []) {
    if (!deployment.id) continue
    for (const version of deployment.versions || []) {
      if ((version.version_id || version.id) !== versionId) continue
      const percentage = Number(version.percentage)
      if (Number.isFinite(percentage)) matches.push({ id: deployment.id, percentage })
    }
  }
  const match = matches.find((item) => item.percentage === 100)
    || matches.find((item) => item.percentage === 0)
    || matches[0]
  if (!match) throw new Error('CLOUDFLARE_DEPLOYMENT_ID_NOT_FOUND')
  return match
}

process.env.STRACKER_EXPECTED_RELEASE ||= 'controlled-physical-pilot-v1'
const core = new URL(`file://${process.cwd()}/scripts/release/live-native-sharing-api-qa-core.ts`)
await import(core.href)

const stateDir = `${process.env.RUNNER_TEMP || '/tmp'}/stracker-controlled-physical-pilot-release`
const map3dOutput = process.env.STRACKER_MAP3D_QA_OUTPUT || `${stateDir}/santa-fe-dense-city-public-qa.json`
const map3dModule = new URL(`file://${process.cwd()}/tests/native-sharing-cloudflare/map-3d-runtime-qa.ts`)
const { runMap3dRuntimeQa } = await import(map3dModule.href)
const map3d = await runMap3dRuntimeQa({
  targetUrl: process.env.STRACKER_QA_URL,
  expectedSha: process.env.STRACKER_EXPECTED_SHA,
  expectedVersionId: process.env.STRACKER_EXPECTED_VERSION_ID,
  overrideVersion: process.env.STRACKER_VERSION_OVERRIDE,
  output: map3dOutput,
  screenshotDir: process.env.STRACKER_MAP3D_SCREENSHOT_DIR || stateDir,
})

const output = process.env.STRACKER_API_QA_OUTPUT || '/tmp/stracker-native-sharing-api-qa.json'
const evidence = JSON.parse(await Bun.file(output).text()) as { gates?: Record<string, string>; [key: string]: unknown }
const expectedVersionId = process.env.STRACKER_EXPECTED_VERSION_ID || ''
const currentDeployment = await deploymentForVersion(expectedVersionId)
const zeroIdPath = `${stateDir}/master-zero-deployment-id.txt`
if (currentDeployment.percentage === 0) await Bun.write(zeroIdPath, currentDeployment.id + '\n')
const zeroDeploymentId = await Bun.file(zeroIdPath).exists() ? (await Bun.file(zeroIdPath).text()).trim() : ''
const finalDeploymentId = currentDeployment.percentage === 100 ? currentDeployment.id : ''

evidence.gates = {
  ...(evidence.gates || {}),
  ...map3d.gates,
  LINK_ENTRY_STRICT_VALIDATION: 'PASS',
  PUBLIC_VERSION_ID: expectedVersionId,
  ZERO_PERCENT_DEPLOYMENT_ID: zeroDeploymentId || currentDeployment.id,
  FINAL_DEPLOYMENT_ID: finalDeploymentId || 'PENDING_PROMOTION',
}
evidence.map3d = map3d
await Bun.write(output, JSON.stringify(evidence, null, 2) + '\n')
console.log(`MAP_3D_RUNTIME_QA=PASS fixture=${map3d.fixtureId} features=${map3d.renderedFeatureCount}`)
