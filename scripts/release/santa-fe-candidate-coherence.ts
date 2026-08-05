import { createHash } from 'node:crypto'

export type CandidateFailureClassification =
  | 'CLOUDFLARE_PROPAGATION_RACE'
  | 'BUILD_JSON_SOURCE_SHA_MISMATCH'
  | 'BUILD_JSON_RELEASE_MISMATCH'
  | 'ASSET_BINDING_VERSION_SKEW'
  | 'AFFINITY_ROUTING_INCONSISTENT'
  | 'VERSION_METADATA_MISMATCH'
  | 'OTHER_EVIDENCED'

export interface CandidateExpectedState {
  sourceSha: string
  release: string
  versionId: string
  manifest: {
    final_features: number
    unique_height_bucket_count: number
    uniform_default_height_fraction: number
    asset_paths: string[]
  }
}

export interface CandidateObservation {
  attempt: number
  elapsedMs: number
  buildHttpStatus: number
  buildContentType: string
  buildCfCacheStatus: string
  buildEtagPresent: boolean
  buildResponseAge: number | null
  observedBuildSourceSha: string
  observedBuildRelease: string
  versionHttpStatus: number
  observedVersionIdHash: string
  observedVersionSourceSha: string
  manifestHttpStatus: number
  manifestExact: boolean
  rangeHttpStatus: number
  rangeContentRangeValid: boolean
  rangeTransportMarkerValid: boolean
  rangeLengthValid: boolean
  classification: CandidateFailureClassification | 'PASS'
}

export interface CandidateCoherenceResult {
  attempts: number
  elapsedMs: number
  rootCause: CandidateFailureClassification | 'NONE'
  firstFailure: CandidateFailureClassification | 'NONE'
  finalObservation: CandidateObservation
  expectedVersionIdHash: string
  affinityKeyHash: string
  requiredConsecutivePasses: number
  consecutivePasses: number
}

export interface CandidateCoherenceOptions {
  targetUrl: string
  expected: CandidateExpectedState
  requestHeaders: Record<string, string>
  affinityKeyHash?: string
  maxAttempts?: number
  initialDelayMs?: number
  maxTotalWaitMs?: number
  requestTimeoutMs?: number
  requiredConsecutivePasses?: number
  fetchImpl?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
  log?: (line: string) => void
}

export class CandidateCoherenceError extends Error {
  constructor(
    readonly classification: CandidateFailureClassification,
    readonly observation: CandidateObservation,
  ) {
    super(classification)
  }
}

export function irreversibleHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeSha(value: unknown): string {
  const text = String(value || '')
  return /^[0-9a-f]{40}$/.test(text) ? text : 'MISSING_OR_INVALID'
}

function safeToken(value: unknown): string {
  return String(value || 'MISSING').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 96)
}

function integerHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name)
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

async function jsonPayload(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const payload = await response.json()
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function manifestMatches(observed: Record<string, unknown> | null, expected: CandidateExpectedState['manifest']): boolean {
  if (!observed) return false
  return observed.final_features === expected.final_features
    && observed.unique_height_bucket_count === expected.unique_height_bucket_count
    && observed.uniform_default_height_fraction === expected.uniform_default_height_fraction
    && JSON.stringify(observed.asset_paths) === JSON.stringify(expected.asset_paths)
}

function classifyObservation(
  observation: Omit<CandidateObservation, 'classification'>,
  expected: CandidateExpectedState,
): CandidateFailureClassification | 'PASS' {
  if (observation.versionHttpStatus !== 200) return 'VERSION_METADATA_MISMATCH'
  if (observation.observedVersionSourceSha !== expected.sourceSha) return 'VERSION_METADATA_MISMATCH'
  if (observation.observedVersionIdHash !== irreversibleHash(expected.versionId)) return 'VERSION_METADATA_MISMATCH'
  if (observation.buildHttpStatus !== 200) return 'ASSET_BINDING_VERSION_SKEW'
  if (observation.observedBuildSourceSha !== expected.sourceSha) return 'BUILD_JSON_SOURCE_SHA_MISMATCH'
  if (observation.observedBuildRelease !== expected.release) return 'BUILD_JSON_RELEASE_MISMATCH'
  if (observation.manifestHttpStatus !== 200 || !observation.manifestExact) return 'ASSET_BINDING_VERSION_SKEW'
  if (
    observation.rangeHttpStatus !== 206
    || !observation.rangeContentRangeValid
    || !observation.rangeTransportMarkerValid
    || !observation.rangeLengthValid
  ) return 'ASSET_BINDING_VERSION_SKEW'
  return 'PASS'
}

function diagnosticLine(
  expected: CandidateExpectedState,
  affinityKeyHash: string,
  observation: CandidateObservation,
  consecutivePasses: number,
  requiredConsecutivePasses: number,
): string {
  return [
    `CANDIDATE_IDENTITY_ATTEMPT=${observation.attempt}`,
    `ELAPSED_MS=${observation.elapsedMs}`,
    `EXPECTED_SOURCE_SHA=${expected.sourceSha}`,
    `OBSERVED_BUILD_SOURCE_SHA=${observation.observedBuildSourceSha}`,
    `EXPECTED_RELEASE=${safeToken(expected.release)}`,
    `OBSERVED_BUILD_RELEASE=${safeToken(observation.observedBuildRelease)}`,
    `BUILD_HTTP_STATUS=${observation.buildHttpStatus}`,
    `BUILD_CONTENT_TYPE=${safeToken(observation.buildContentType)}`,
    `BUILD_CF_CACHE_STATUS=${safeToken(observation.buildCfCacheStatus)}`,
    `BUILD_ETAG_PRESENT=${observation.buildEtagPresent ? 'YES' : 'NO'}`,
    `BUILD_RESPONSE_AGE=${observation.buildResponseAge ?? 'ABSENT'}`,
    `EXPECTED_VERSION_ID_HASH=${irreversibleHash(expected.versionId)}`,
    `OBSERVED_VERSION_ID_HASH=${observation.observedVersionIdHash}`,
    `OBSERVED_VERSION_SOURCE_SHA=${observation.observedVersionSourceSha}`,
    `VERSION_HTTP_STATUS=${observation.versionHttpStatus}`,
    `AFFINITY_KEY_HASH=${affinityKeyHash}`,
    `CONSECUTIVE_PASS_COUNT=${consecutivePasses}`,
    `REQUIRED_CONSECUTIVE_PASSES=${requiredConsecutivePasses}`,
    `CLASSIFICATION=${observation.classification}`,
  ].join(' ')
}

async function observeAttempt(
  options: Required<Pick<CandidateCoherenceOptions, 'fetchImpl' | 'now' | 'requestTimeoutMs'>> & CandidateCoherenceOptions,
  attempt: number,
  startedAt: number,
): Promise<CandidateObservation> {
  const target = new URL(options.targetUrl)
  const nonce = `${options.now()}-${attempt}`
  const headers = { ...options.requestHeaders, Accept: 'application/json', 'Cache-Control': 'no-cache' }
  const remaining = Math.max(1, (options.maxTotalWaitMs ?? 90_000) - (options.now() - startedAt))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.min(options.requestTimeoutMs, remaining))
  try {
    const rangeUrl = new URL(options.expected.manifest.asset_paths[0], target)
    rangeUrl.searchParams.set('pmtilesOffset', '0')
    rangeUrl.searchParams.set('pmtilesLength', '16384')
    rangeUrl.searchParams.set('candidate', nonce)
    const [buildResponse, versionResponse, manifestResponse, rangeResponse] = await Promise.all([
      options.fetchImpl(new URL(`/__stracker/build.json?candidate=${nonce}`, target), { headers, cache: 'no-store', signal: controller.signal }),
      options.fetchImpl(new URL(`/__stracker/version.json?candidate=${nonce}`, target), { headers, cache: 'no-store', signal: controller.signal }),
      options.fetchImpl(new URL(`/data/santa-fe-3d/manifest.json?candidate=${nonce}`, target), { headers, cache: 'no-store', signal: controller.signal }),
      options.fetchImpl(rangeUrl, {
        headers: { ...headers, Range: 'bytes=0-16383', 'Accept-Encoding': 'identity' },
        cache: 'no-store',
        signal: controller.signal,
      }),
    ])
    const [build, version, observedManifest, rangeBytes] = await Promise.all([
      jsonPayload(buildResponse),
      jsonPayload(versionResponse),
      jsonPayload(manifestResponse),
      rangeResponse.arrayBuffer().catch(() => new ArrayBuffer(0)),
    ])
    const base = {
      attempt,
      elapsedMs: options.now() - startedAt,
      buildHttpStatus: buildResponse.status,
      buildContentType: buildResponse.headers.get('content-type') || 'ABSENT',
      buildCfCacheStatus: buildResponse.headers.get('cf-cache-status') || 'ABSENT',
      buildEtagPresent: Boolean(buildResponse.headers.get('etag')),
      buildResponseAge: integerHeader(buildResponse.headers, 'age'),
      observedBuildSourceSha: safeSha(build?.sourceSha),
      observedBuildRelease: safeToken(build?.release),
      versionHttpStatus: versionResponse.status,
      observedVersionIdHash: irreversibleHash(String(version?.versionId || 'MISSING')),
      observedVersionSourceSha: safeSha(version?.sourceSha),
      manifestHttpStatus: manifestResponse.status,
      manifestExact: manifestMatches(observedManifest, options.expected.manifest),
      rangeHttpStatus: rangeResponse.status,
      rangeContentRangeValid: /^bytes 0-16383\/\d+$/.test(rangeResponse.headers.get('content-range') || ''),
      rangeTransportMarkerValid: rangeResponse.headers.get('x-stracker-pmtiles-transport') === 'query-v1',
      rangeLengthValid: rangeBytes.byteLength === 16_384,
    }
    return { ...base, classification: classifyObservation(base, options.expected) }
  } catch {
    const base = {
      attempt,
      elapsedMs: options.now() - startedAt,
      buildHttpStatus: 0,
      buildContentType: 'FETCH_ERROR',
      buildCfCacheStatus: 'ABSENT',
      buildEtagPresent: false,
      buildResponseAge: null,
      observedBuildSourceSha: 'MISSING_OR_INVALID',
      observedBuildRelease: 'MISSING',
      versionHttpStatus: 0,
      observedVersionIdHash: irreversibleHash('MISSING'),
      observedVersionSourceSha: 'MISSING_OR_INVALID',
      manifestHttpStatus: 0,
      manifestExact: false,
      rangeHttpStatus: 0,
      rangeContentRangeValid: false,
      rangeTransportMarkerValid: false,
      rangeLengthValid: false,
    }
    return { ...base, classification: 'OTHER_EVIDENCED' }
  } finally {
    clearTimeout(timeout)
  }
}

export async function runCandidateCoherenceRetry(options: CandidateCoherenceOptions): Promise<CandidateCoherenceResult> {
  if (!/^[0-9a-f]{40}$/.test(options.expected.sourceSha)) throw new Error('EXPECTED_SOURCE_SHA_INVALID')
  if (!options.expected.release || !options.expected.versionId) throw new Error('EXPECTED_IDENTITY_INCOMPLETE')
  if (!options.expected.manifest.asset_paths.length) throw new Error('EXPECTED_ASSET_PATH_REQUIRED')
  const maxAttempts = options.maxAttempts ?? 30
  const delayMs = options.initialDelayMs ?? 2_000
  const maxTotalWaitMs = options.maxTotalWaitMs ?? 90_000
  const requiredConsecutivePasses = options.requiredConsecutivePasses ?? 1
  if (
    maxAttempts < 1 || maxAttempts > 30 || delayMs < 0 || maxTotalWaitMs > 90_000
    || requiredConsecutivePasses < 1 || requiredConsecutivePasses > 5
  ) throw new Error('RETRY_CONTRACT_INVALID')
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds))
  const now = options.now ?? (() => Date.now())
  const log = options.log ?? console.log
  const affinityKeyHash = options.affinityKeyHash || 'NOT_APPLICABLE'
  const startedAt = now()
  let firstFailure: CandidateFailureClassification | 'NONE' = 'NONE'
  let lastObservation: CandidateObservation | null = null
  let consecutivePasses = 0
  let sawPass = false

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const observation = await observeAttempt({
      ...options,
      fetchImpl,
      now,
      requestTimeoutMs: options.requestTimeoutMs ?? 12_000,
      maxTotalWaitMs,
    }, attempt, startedAt)
    lastObservation = observation
    if (observation.classification === 'PASS') {
      sawPass = true
      consecutivePasses += 1
    } else {
      consecutivePasses = 0
      if (firstFailure === 'NONE') firstFailure = observation.classification
    }
    log(diagnosticLine(options.expected, affinityKeyHash, observation, consecutivePasses, requiredConsecutivePasses))
    if (consecutivePasses >= requiredConsecutivePasses) {
      return {
        attempts: attempt,
        elapsedMs: now() - startedAt,
        rootCause: firstFailure === 'NONE' ? 'NONE' : 'CLOUDFLARE_PROPAGATION_RACE',
        firstFailure,
        finalObservation: observation,
        expectedVersionIdHash: irreversibleHash(options.expected.versionId),
        affinityKeyHash,
        requiredConsecutivePasses,
        consecutivePasses,
      }
    }
    if (attempt >= maxAttempts || now() - startedAt + delayMs > maxTotalWaitMs) break
    await sleep(delayMs)
  }

  const observation = lastObservation || {
    attempt: 0,
    elapsedMs: now() - startedAt,
    buildHttpStatus: 0,
    buildContentType: 'NO_ATTEMPT',
    buildCfCacheStatus: 'ABSENT',
    buildEtagPresent: false,
    buildResponseAge: null,
    observedBuildSourceSha: 'MISSING_OR_INVALID',
    observedBuildRelease: 'MISSING',
    versionHttpStatus: 0,
    observedVersionIdHash: irreversibleHash('MISSING'),
    observedVersionSourceSha: 'MISSING_OR_INVALID',
    manifestHttpStatus: 0,
    manifestExact: false,
    rangeHttpStatus: 0,
    rangeContentRangeValid: false,
    rangeTransportMarkerValid: false,
    rangeLengthValid: false,
    classification: 'OTHER_EVIDENCED' as const,
  }
  const classification: CandidateFailureClassification = sawPass && requiredConsecutivePasses > 1
    ? 'AFFINITY_ROUTING_INCONSISTENT'
    : observation.classification === 'PASS' ? 'OTHER_EVIDENCED' : observation.classification
  throw new CandidateCoherenceError(classification, observation)
}
