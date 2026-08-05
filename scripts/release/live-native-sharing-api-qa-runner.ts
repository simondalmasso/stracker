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
  if (url.pathname.endsWith('.pmtiles')) {
    url.search = ''
    const headers = new Headers(init?.headers)
    headers.set('Accept-Encoding', 'identity')
    return originalFetch(url, { ...init, headers })
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

interface SantaFeStaticManifest {
  final_features: number
  unique_height_bucket_count: number
  uniform_default_height_fraction: number
  asset_paths: string[]
}

async function waitForSantaFeStaticAssets(): Promise<void> {
  const rawTarget = process.env.STRACKER_QA_URL || ''
  if (!rawTarget) return
  const target = new URL(rawTarget)
  const expected = await Bun.file('public/data/santa-fe-3d/manifest.json').json() as SantaFeStaticManifest
  const overrideVersion = process.env.STRACKER_VERSION_OVERRIDE || ''
  const headers = {
    'Cache-Control': 'no-cache',
    ...(overrideVersion ? { 'Cloudflare-Workers-Version-Overrides': `stracker="${overrideVersion}"` } : {}),
  }
  let lastFailure = 'MANIFEST_UNAVAILABLE'

  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const nonce = `${Date.now()}-${attempt}-${Math.random().toString(36).slice(2)}`
    try {
      const manifestResponse = await originalFetch(
        new URL(`/data/santa-fe-3d/manifest.json?propagation=${nonce}`, target),
        { headers, cache: 'no-store' },
      )
      if (manifestResponse.status !== 200) {
        lastFailure = `MANIFEST_HTTP_${manifestResponse.status}`
      } else {
        const remote = await manifestResponse.json().catch(() => null) as SantaFeStaticManifest | null
        const manifestMatches = Boolean(
          remote
          && remote.final_features === expected.final_features
          && remote.unique_height_bucket_count === expected.unique_height_bucket_count
          && remote.uniform_default_height_fraction === expected.uniform_default_height_fraction
          && JSON.stringify(remote.asset_paths) === JSON.stringify(expected.asset_paths),
        )
        if (!manifestMatches) {
          lastFailure = 'MANIFEST_CONTRACT_MISMATCH'
        } else {
          let allRangesReady = true
          for (const path of expected.asset_paths) {
            const rangeResponse = await originalFetch(
              new URL(path, target),
              { headers: { ...headers, Range: 'bytes=0-16383', 'Accept-Encoding': 'identity' }, cache: 'no-store' },
            )
            const body = await rangeResponse.arrayBuffer()
            const contentRange = rangeResponse.headers.get('content-range') || ''
            const valid = rangeResponse.status === 206
              && rangeResponse.headers.get('accept-ranges')?.toLowerCase() === 'bytes'
              && /^bytes 0-\d+\/\d+$/.test(contentRange)
              && body.byteLength > 0
              && body.byteLength <= 16_384
            if (!valid) {
              lastFailure = `PMTILES_RANGE_NOT_READY_${rangeResponse.status}`
              allRangesReady = false
              break
            }
          }
          if (allRangesReady) {
            console.log(`SANTA_FE_STATIC_ASSET_PROPAGATION=PASS attempt=${attempt}`)
            return
          }
        }
      }
    } catch {
      lastFailure = 'NETWORK_OR_PARSE_FAILURE'
    }
    if (attempt < 30) await Bun.sleep(2_000)
  }
  throw new Error(`SANTA_FE_STATIC_ASSET_PROPAGATION_TIMEOUT_${lastFailure}`)
}

process.env.STRACKER_EXPECTED_RELEASE ||= 'controlled-physical-pilot-v1'
const core = new URL(`file://${process.cwd()}/scripts/release/live-native-sharing-api-qa-core.ts`)
await import(core.href)
await waitForSantaFeStaticAssets()

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
  SANTA_FE_STATIC_ASSET_PROPAGATION: 'PASS',
  LINK_ENTRY_STRICT_VALIDATION: 'PASS',
  PUBLIC_VERSION_ID: expectedVersionId,
  ZERO_PERCENT_DEPLOYMENT_ID: zeroDeploymentId || currentDeployment.id,
  FINAL_DEPLOYMENT_ID: finalDeploymentId || 'PENDING_PROMOTION',
}
evidence.map3d = map3d
await Bun.write(output, JSON.stringify(evidence, null, 2) + '\n')
console.log(`MAP_3D_RUNTIME_QA=PASS fixture=${map3d.fixtureId} features=${map3d.renderedFeatureCount}`)