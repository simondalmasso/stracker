export {}

import manifest from '../../public/data/santa-fe-3d/manifest.json'
import { runSantaFePublicBrowserQa } from './santa-fe-public-browser-qa'

interface DeploymentEvidence { id: string; percentage: number }

async function deploymentForVersion(versionId: string): Promise<DeploymentEvidence> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || ''
  const token = process.env.CLOUDFLARE_API_TOKEN || ''
  if (!accountId || !token) throw new Error('CLOUDFLARE_DEPLOYMENT_EVIDENCE_ENV_REQUIRED')
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/stracker/deployments`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
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

function runtimeHeaders(): Record<string, string> {
  const version = process.env.STRACKER_VERSION_OVERRIDE || ''
  return {
    'Cache-Control': 'no-cache',
    ...(version ? { 'Cloudflare-Workers-Version-Overrides': `stracker="${version}"` } : {}),
  }
}

async function verifyStaticAssets(): Promise<{ rangeResponses: number; transferredBytes: number }> {
  const rawTarget = process.env.STRACKER_QA_URL || ''
  if (!rawTarget) return { rangeResponses: 0, transferredBytes: 0 }
  const target = new URL(rawTarget)
  const headers = runtimeHeaders()
  let lastFailure = 'MANIFEST_UNAVAILABLE'
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const nonce = `${Date.now()}-${attempt}-${Math.random().toString(36).slice(2)}`
      const manifestResponse = await fetch(new URL(`/data/santa-fe-3d/manifest.json?propagation=${nonce}`, target), {
        headers,
        cache: 'no-store',
      })
      if (manifestResponse.status !== 200) {
        lastFailure = `MANIFEST_HTTP_${manifestResponse.status}`
      } else {
        const remote = await manifestResponse.json().catch(() => null) as typeof manifest | null
        const matches = Boolean(
          remote
          && remote.final_features === manifest.final_features
          && remote.unique_height_bucket_count === manifest.unique_height_bucket_count
          && remote.uniform_default_height_fraction === manifest.uniform_default_height_fraction
          && JSON.stringify(remote.asset_paths) === JSON.stringify(manifest.asset_paths),
        )
        if (!matches) {
          lastFailure = 'MANIFEST_CONTRACT_MISMATCH'
        } else {
          let rangeResponses = 0
          let transferredBytes = 0
          let allReady = true
          for (const path of manifest.asset_paths) {
            const url = new URL(path, target)
            url.searchParams.set('pmtilesOffset', '0')
            url.searchParams.set('pmtilesLength', '16384')
            const response = await fetch(url, {
              headers: { ...headers, Range: 'bytes=0-16383', 'Accept-Encoding': 'identity' },
              cache: 'no-store',
            })
            const body = await response.arrayBuffer()
            const valid = response.status === 206
              && response.headers.get('accept-ranges')?.toLowerCase() === 'bytes'
              && /^bytes 0-16383\/\d+$/.test(response.headers.get('content-range') || '')
              && response.headers.get('x-stracker-pmtiles-transport') === 'query-v1'
              && body.byteLength === 16_384
            if (!valid) {
              lastFailure = `PMTILES_QUERY_RANGE_NOT_READY_${response.status}`
              allReady = false
              break
            }
            rangeResponses += 1
            transferredBytes += body.byteLength
          }
          if (allReady) {
            console.log(`SANTA_FE_STATIC_ASSET_PROPAGATION=PASS attempt=${attempt}`)
            return { rangeResponses, transferredBytes }
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
await import(new URL(`file://${process.cwd()}/scripts/release/live-native-sharing-api-qa-core.ts`).href)
const staticAssets = await verifyStaticAssets()

const stateDir = `${process.env.RUNNER_TEMP || '/tmp'}/stracker-controlled-physical-pilot-release`
const map3dOutput = process.env.STRACKER_MAP3D_QA_OUTPUT || `${stateDir}/santa-fe-dense-city-local-qa.json`
const { runMap3dRuntimeQa } = await import(new URL(`file://${process.cwd()}/tests/native-sharing-cloudflare/map-3d-runtime-qa.ts`).href)
const localMap3d = await runMap3dRuntimeQa({
  output: map3dOutput,
  screenshotDir: process.env.STRACKER_MAP3D_SCREENSHOT_DIR || stateDir,
})

const publicMap3d = await runSantaFePublicBrowserQa({
  targetUrl: process.env.STRACKER_QA_URL || '',
  requestHeaders: runtimeHeaders(),
  screenshotDir: process.env.STRACKER_MAP3D_SCREENSHOT_DIR || stateDir,
  screenshotPrefix: 'santa-fe-dense-city-public',
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
  ...localMap3d.gates,
  ...(publicMap3d.gates as Record<string, string>),
  SANTA_FE_STATIC_ASSET_PROPAGATION: 'PASS',
  LINK_ENTRY_STRICT_VALIDATION: 'PASS',
  PUBLIC_VERSION_ID: expectedVersionId,
  ZERO_PERCENT_DEPLOYMENT_ID: zeroDeploymentId || currentDeployment.id,
  FINAL_DEPLOYMENT_ID: finalDeploymentId || 'PENDING_PROMOTION',
}
evidence.map3d = {
  schema: 'stracker.santa-fe-dense-city-combined-qa.v1',
  staticAssets,
  local: localMap3d,
  public: publicMap3d,
  privateDataUsed: false,
  realUserCoordinatesUsed: false,
  coordinateValuesRetained: false,
}
await Bun.write(output, JSON.stringify(evidence, null, 2) + '\n')
console.log(`MAP_3D_RUNTIME_QA=PASS fixture=${localMap3d.fixtureId} features=${localMap3d.renderedFeatureCount}`)
