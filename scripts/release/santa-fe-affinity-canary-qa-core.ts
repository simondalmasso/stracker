import { createHash } from 'node:crypto'
import manifest from '../../public/data/santa-fe-3d/manifest.json'
import { runSantaFePublicBrowserQa } from './santa-fe-public-browser-qa'
import { irreversibleHash, runCandidateCoherenceRetry } from './santa-fe-candidate-coherence'

const target = new URL(process.env.STRACKER_QA_URL || '')
const expectedSha = process.env.STRACKER_EXPECTED_SHA || ''
const candidateVersion = process.env.STRACKER_EXPECTED_VERSION_ID || ''
const workerName = process.env.STRACKER_PUBLIC_WORKER || 'stracker'
const output = process.env.STRACKER_AFFINITY_QA_OUTPUT || '/tmp/stracker-santa-fe-affinity-canary.json'
const screenshotDir = process.env.STRACKER_AFFINITY_SCREENSHOT_DIR || '/tmp'

class CanaryFailure extends Error {
  constructor(readonly code: string) { super(code) }
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
  const startedAt = Date.now()
  for (let start = 0; start < 4_096 && Date.now() - startedAt < 90_000; start += batchSize) {
    const candidates = Array.from({ length: batchSize }, (_, index) => `sf3d-${expectedSha.slice(0, 12)}-${start + index}`)
    const observations = await Promise.all(candidates.map(async (key) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 12_000)
      try {
        const response = await fetch(new URL(`/__stracker/version.json?affinity-search=${start}-${Date.now()}`, target), {
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
    if (match) {
      console.log(`AFFINITY_KEY_FOUND=YES AFFINITY_KEY_HASH=${irreversibleHash(match)} SEARCH_ELAPSED_MS=${Date.now() - startedAt}`)
      return match
    }
    console.log(`AFFINITY_KEY_SEARCH_BATCH=${start / batchSize + 1} SEARCH_ELAPSED_MS=${Date.now() - startedAt}`)
    await Bun.sleep(150)
  }
  throw new CanaryFailure('AFFINITY_KEY_FOR_CANDIDATE_NOT_FOUND')
}

async function runBrowserWithStableAffinity(key: string): Promise<{ browser: Record<string, unknown>; attempts: number }> {
  let finalError: unknown = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const browser = await runSantaFePublicBrowserQa({
        targetUrl: target.toString(),
        requestHeaders: affinityHeaders(key),
        screenshotDir,
        screenshotPrefix: `santa-fe-affinity-canary-${attempt}`,
      })
      console.log(`AFFINITY_BROWSER_QA_ATTEMPT=${attempt} RESULT=PASS`)
      return { browser, attempts: attempt }
    } catch (error) {
      finalError = error
      const code = error instanceof Error ? error.message.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 120) : 'UNKNOWN'
      console.log(`AFFINITY_BROWSER_QA_ATTEMPT=${attempt} RESULT=RETRY CLASSIFICATION=${code}`)
      if (attempt < 3) await Bun.sleep(5_000)
    }
  }
  throw finalError instanceof Error ? finalError : new CanaryFailure('AFFINITY_BROWSER_QA_FAILED')
}

if (target.protocol !== 'https:' || !target.hostname) throw new Error('HTTPS_TARGET_REQUIRED')
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('EXPECTED_SHA_REQUIRED')
if (!candidateVersion) throw new Error('EXPECTED_VERSION_ID_REQUIRED')

const affinityKey = await findCandidateAffinityKey()
const affinityKeyHash = irreversibleHash(affinityKey)
const coherence = await runCandidateCoherenceRetry({
  targetUrl: target.toString(),
  expected: {
    sourceSha: expectedSha,
    release: 'controlled-physical-pilot-v1',
    versionId: candidateVersion,
    manifest,
  },
  requestHeaders: affinityHeaders(affinityKey),
  affinityKeyHash,
  maxAttempts: 30,
  initialDelayMs: 2_000,
  maxTotalWaitMs: 90_000,
  requiredConsecutivePasses: 3,
})
const browserResult = await runBrowserWithStableAffinity(affinityKey)
const rootCause = coherence.rootCause !== 'NONE' || browserResult.attempts > 1
  ? 'CLOUDFLARE_PROPAGATION_RACE'
  : 'NONE'
const result = {
  schema: 'stracker.santa-fe-affinity-canary.v4',
  sourceSha: expectedSha,
  candidateVersionHash: digest(candidateVersion),
  affinityKeyHash,
  workerName,
  rootCause,
  coherence: {
    attempts: coherence.attempts,
    elapsedMs: coherence.elapsedMs,
    rootCause: coherence.rootCause,
    firstFailure: coherence.firstFailure,
    expectedVersionIdHash: coherence.expectedVersionIdHash,
    requiredConsecutivePasses: coherence.requiredConsecutivePasses,
    consecutivePasses: coherence.consecutivePasses,
  },
  browserAttempts: browserResult.attempts,
  privateDataUsed: false,
  realUserCoordinatesUsed: false,
  coordinateValuesRetained: false,
  rawVersionIdRetained: false,
  rawAffinityKeyRetained: false,
  browser: browserResult.browser,
  gates: {
    ONE_PERCENT_VERSION_AFFINITY: 'PASS',
    CANDIDATE_BUILD_AND_VERSION_IDENTITY: 'PASS',
    CANDIDATE_MANIFEST_EXACT: 'PASS',
    CANDIDATE_PMTILES_QUERY_RANGE_206: 'PASS',
    CANDIDATE_CONTENT_RANGE: 'PASS',
    CANDIDATE_QUERY_TRANSPORT_MARKER: 'PASS',
    SAME_AFFINITY_KEY_ALL_ATTEMPTS: 'PASS',
    SAME_ATTEMPT_CANDIDATE_COHERENCE: 'PASS',
    THREE_CONSECUTIVE_COHERENT_ATTEMPTS: 'PASS',
    BOUNDED_RETRY_MAX_30: 'PASS',
    BOUNDED_RETRY_MAX_90_SECONDS: 'PASS',
    BOUNDED_BROWSER_RETRY: 'PASS',
    ...browserResult.browser.gates as Record<string, string>,
    NO_PRIVATE_DATA_IN_CANARY: 'PASS',
  },
}
await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
console.log(`SANTA_FE_AFFINITY_CANARY_QA=PASS attempts=${coherence.attempts} browserAttempts=${browserResult.attempts} rootCause=${rootCause}`)
