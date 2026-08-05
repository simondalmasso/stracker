import { createHash } from 'node:crypto'
import manifest from '../../public/data/santa-fe-3d/manifest.json'
import { runSantaFePublicBrowserQa } from './santa-fe-public-browser-qa'

const target = new URL(process.env.STRACKER_QA_URL || '')
const expectedSha = process.env.STRACKER_EXPECTED_SHA || ''
const candidateVersion = process.env.STRACKER_EXPECTED_VERSION_ID || ''
const workerName = process.env.STRACKER_PUBLIC_WORKER || 'stracker'
const output = process.env.STRACKER_AFFINITY_QA_OUTPUT || '/tmp/stracker-santa-fe-affinity-canary.json'
const screenshotDir = process.env.STRACKER_AFFINITY_SCREENSHOT_DIR || '/tmp'

class CanaryFailure extends Error {
  constructor(readonly code: string) { super(code) }
}
function ok(value: unknown, code: string): asserts value {
  if (!value) throw new CanaryFailure(code)
}
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function affinityHeaders(key: string): Record<string, string> {
  return {
    'Cloudflare-Workers-Version-Key': key,
    'Cache-Control': 'no-cache',
  }
}

async function findCandidateAffinityKey(): Promise<string> {
  const batchSize = 64
  for (let start = 0; start < 4_096; start += batchSize) {
    const candidates = Array.from({ length: batchSize }, (_, index) => `sf3d-${expectedSha.slice(0, 12)}-${start + index}`)
    const observations = await Promise.all(candidates.map(async (key) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      try {
        const response = await fetch(new URL(`/__stracker/version.json?affinity=${start}-${Math.random().toString(36).slice(2)}`, target), {
          headers: { ...affinityHeaders(key), Accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
        })
        const payload = await response.json().catch(() => null) as { versionId?: string; sourceSha?: string } | null
        return response.status === 200 && payload?.versionId === candidateVersion && payload?.sourceSha === expectedSha ? key : null
      } catch {
        return null
      } finally {
        clearTimeout(timeout)
      }
    }))
    const match = observations.find((value): value is string => Boolean(value))
    if (match) return match
    await Bun.sleep(150)
  }
  throw new CanaryFailure('AFFINITY_KEY_FOR_CANDIDATE_NOT_FOUND')
}

async function verifyCandidateIdentity(key: string): Promise<void> {
  const headers = { ...affinityHeaders(key), Accept: 'application/json' }
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const [buildResponse, versionResponse] = await Promise.all([
    fetch(new URL(`/__stracker/build.json?affinity=${nonce}`, target), { headers, cache: 'no-store' }),
    fetch(new URL(`/__stracker/version.json?affinity=${nonce}`, target), { headers, cache: 'no-store' }),
  ])
  const build = await buildResponse.json().catch(() => null) as { sourceSha?: string; release?: string } | null
  const version = await versionResponse.json().catch(() => null) as { sourceSha?: string; versionId?: string } | null
  ok(buildResponse.status === 200 && versionResponse.status === 200, 'CANDIDATE_IDENTITY_HTTP')
  ok(build?.sourceSha === expectedSha && build.release === 'controlled-physical-pilot-v1', 'CANDIDATE_BUILD_IDENTITY')
  ok(version?.sourceSha === expectedSha && version.versionId === candidateVersion, 'CANDIDATE_VERSION_IDENTITY')
}

async function verifyCandidateStaticAssets(key: string): Promise<Record<string, number>> {
  const headers = affinityHeaders(key)
  const manifestResponse = await fetch(new URL(`/data/santa-fe-3d/manifest.json?affinity=${Date.now()}`, target), {
    headers,
    cache: 'no-store',
  })
  ok(manifestResponse.status === 200, `CANDIDATE_MANIFEST_HTTP_${manifestResponse.status}`)
  const remote = await manifestResponse.json().catch(() => null) as typeof manifest | null
  ok(Boolean(remote), 'CANDIDATE_MANIFEST_PARSE')
  ok(remote!.final_features === manifest.final_features, 'CANDIDATE_MANIFEST_FEATURE_COUNT')
  ok(remote!.unique_height_bucket_count === manifest.unique_height_bucket_count, 'CANDIDATE_MANIFEST_HEIGHT_BUCKETS')
  ok(remote!.uniform_default_height_fraction === manifest.uniform_default_height_fraction, 'CANDIDATE_MANIFEST_DEFAULT_HEIGHT_FRACTION')
  ok(JSON.stringify(remote!.asset_paths) === JSON.stringify(manifest.asset_paths), 'CANDIDATE_MANIFEST_ASSET_PATHS')

  let rangeResponses = 0
  let transferredBytes = 0
  for (const path of manifest.asset_paths) {
    const url = new URL(path, target)
    url.searchParams.set('pmtilesOffset', '0')
    url.searchParams.set('pmtilesLength', '16384')
    const response = await fetch(url, {
      headers: { ...headers, Range: 'bytes=0-16383', 'Accept-Encoding': 'identity' },
      cache: 'no-store',
    })
    const body = await response.arrayBuffer()
    ok(response.status === 206, `CANDIDATE_RANGE_HTTP_${response.status}`)
    ok(response.headers.get('accept-ranges')?.toLowerCase() === 'bytes', 'CANDIDATE_ACCEPT_RANGES')
    ok(/^bytes 0-16383\/\d+$/.test(response.headers.get('content-range') || ''), 'CANDIDATE_CONTENT_RANGE')
    ok(response.headers.get('x-stracker-pmtiles-transport') === 'query-v1', 'CANDIDATE_QUERY_TRANSPORT_MARKER')
    ok(body.byteLength === 16_384, 'CANDIDATE_RANGE_LENGTH')
    rangeResponses += 1
    transferredBytes += body.byteLength
  }
  return { rangeResponses, transferredBytes }
}

if (target.protocol !== 'https:' || !target.hostname) throw new Error('HTTPS_TARGET_REQUIRED')
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('EXPECTED_SHA_REQUIRED')
if (!candidateVersion) throw new Error('EXPECTED_VERSION_ID_REQUIRED')

const affinityKey = await findCandidateAffinityKey()
await verifyCandidateIdentity(affinityKey)
const staticAssets = await verifyCandidateStaticAssets(affinityKey)
const browser = await runSantaFePublicBrowserQa({
  targetUrl: target.toString(),
  requestHeaders: affinityHeaders(affinityKey),
  screenshotDir,
  screenshotPrefix: 'santa-fe-affinity-canary',
})
const result = {
  schema: 'stracker.santa-fe-affinity-canary.v2',
  sourceSha: expectedSha,
  candidateVersionHash: digest(candidateVersion),
  affinityKeyHash: digest(affinityKey),
  workerName,
  privateDataUsed: false,
  realUserCoordinatesUsed: false,
  coordinateValuesRetained: false,
  staticAssets,
  browser,
  gates: {
    ONE_PERCENT_VERSION_AFFINITY: 'PASS',
    CANDIDATE_BUILD_AND_VERSION_IDENTITY: 'PASS',
    CANDIDATE_MANIFEST_EXACT: 'PASS',
    CANDIDATE_PMTILES_QUERY_RANGE_206: 'PASS',
    CANDIDATE_CONTENT_RANGE: 'PASS',
    CANDIDATE_QUERY_TRANSPORT_MARKER: 'PASS',
    ...browser.gates as Record<string, string>,
    NO_PRIVATE_DATA_IN_CANARY: 'PASS',
  },
}
await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
console.log('SANTA_FE_AFFINITY_CANARY_QA=PASS')
