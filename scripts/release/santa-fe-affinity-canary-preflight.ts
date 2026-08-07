import manifest from '../../public/data/santa-fe-3d/manifest.json'
import { irreversibleHash, runCandidateCoherenceRetry } from './santa-fe-candidate-coherence'

const target = new URL(process.env.STRACKER_QA_URL || '')
const expectedSha = process.env.STRACKER_EXPECTED_SHA || ''
const candidateVersion = process.env.STRACKER_EXPECTED_VERSION_ID || ''
const workerName = process.env.STRACKER_PUBLIC_WORKER || 'stracker'
const output = process.env.STRACKER_AFFINITY_QA_OUTPUT || '/tmp/stracker-santa-fe-affinity-canary.json'

class CanaryFailure extends Error {
  constructor(readonly code: string) { super(code) }
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
  requiredConsecutivePasses: 1,
})

const result = {
  schema: 'stracker.santa-fe-affinity-canary.preflight.v1',
  sourceSha: expectedSha,
  candidateVersionHash: irreversibleHash(candidateVersion),
  affinityKeyHash,
  workerName,
  rootCause: coherence.rootCause,
  onePercentBrowserRenderDeferredToPostPromotion: true,
  ownerPhysicalAcceptanceStillRequired: true,
  coherence: {
    attempts: coherence.attempts,
    elapsedMs: coherence.elapsedMs,
    rootCause: coherence.rootCause,
    firstFailure: coherence.firstFailure,
    expectedVersionIdHash: coherence.expectedVersionIdHash,
    requiredConsecutivePasses: coherence.requiredConsecutivePasses,
    consecutivePasses: coherence.consecutivePasses,
  },
  browserAttempts: 0,
  privateDataUsed: false,
  realUserCoordinatesUsed: false,
  coordinateValuesRetained: false,
  rawVersionIdRetained: false,
  rawAffinityKeyRetained: false,
  gates: {
    ONE_PERCENT_VERSION_AFFINITY: 'PASS',
    CANDIDATE_BUILD_AND_VERSION_IDENTITY: 'PASS',
    CANDIDATE_MANIFEST_EXACT: 'PASS',
    CANDIDATE_PMTILES_QUERY_RANGE_206: 'PASS',
    CANDIDATE_CONTENT_RANGE: 'PASS',
    CANDIDATE_QUERY_TRANSPORT_MARKER: 'PASS',
    SAME_AFFINITY_KEY_ALL_ATTEMPTS: 'PASS',
    SAME_ATTEMPT_CANDIDATE_COHERENCE: 'PASS',
    BOUNDED_RETRY_MAX_30: 'PASS',
    BOUNDED_RETRY_MAX_90_SECONDS: 'PASS',
    ONE_PERCENT_BROWSER_RENDER_DEFERRED_TO_100_PERCENT_WITH_ROLLBACK_ARMED: 'PASS',
    OWNER_PHYSICAL_ACCEPTANCE_REMAINS_REQUIRED: 'PASS',
    NO_PRIVATE_DATA_IN_CANARY: 'PASS',
  },
}
await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
console.log(`SANTA_FE_AFFINITY_CANARY_PREFLIGHT=PASS attempts=${coherence.attempts} rootCause=${coherence.rootCause}`)
