import { describe, expect, test } from 'bun:test'
import manifest from '../../public/data/santa-fe-3d/manifest.json'
import { handleMinimumRuntimeRequest } from '../../native-sharing-cloudflare/src/minimal-worker'
import {
  CandidateCoherenceError,
  runCandidateCoherenceRetry,
  type CandidateCoherenceOptions,
  type CandidateFailureClassification,
} from '../../scripts/release/santa-fe-candidate-coherence'
import {
  PMTILES_LENGTH_PARAM,
  PMTILES_OFFSET_PARAM,
  PMTILES_QUERY_TRANSPORT,
  pmtilesQueryRangeUrl,
} from '../../src/lib/location-source/map-engine/pmtiles-query-source'

const sourceSha = 'a'.repeat(40)
const candidateVersion = 'candidate-version-sensitive-value'
const affinityKey = 'affinity-key-sensitive-value'

type AttemptState = {
  buildSha?: string
  release?: string
  versionSha?: string
  versionId?: string
  manifestExact?: boolean
  rangeValid?: boolean
}

function responseJson(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function candidateFetch(states: AttemptState[], observedKeys: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    const key = request.headers.get('Cloudflare-Workers-Version-Key')
    if (key) observedKeys.push(key)
    const marker = url.searchParams.get('candidate') || '0-1'
    const attempt = Math.max(1, Number(marker.split('-').at(-1) || 1))
    const state = states[Math.min(attempt - 1, states.length - 1)] || {}
    if (url.pathname === '/__stracker/build.json') {
      return responseJson(
        { sourceSha: state.buildSha ?? sourceSha, release: state.release ?? 'controlled-physical-pilot-v1' },
        { 'CF-Cache-Status': 'DYNAMIC', ETag: '"fixture"', Age: '0' },
      )
    }
    if (url.pathname === '/__stracker/version.json') {
      return responseJson({ sourceSha: state.versionSha ?? sourceSha, versionId: state.versionId ?? candidateVersion })
    }
    if (url.pathname === '/data/santa-fe-3d/manifest.json') {
      return responseJson(state.manifestExact === false ? { ...manifest, final_features: manifest.final_features - 1 } : manifest)
    }
    if (url.pathname.endsWith('.pmtiles')) {
      const valid = state.rangeValid !== false
      return new Response(new Uint8Array(valid ? 16_384 : 4), {
        status: valid ? 206 : 200,
        headers: valid ? {
          'Content-Range': 'bytes 0-16383/999999',
          'X-Stracker-PMTiles-Transport': 'query-v1',
          'Content-Length': '16384',
        } : {},
      })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

async function runRetry(states: AttemptState[], extra: Partial<CandidateCoherenceOptions> = {}) {
  const logs: string[] = []
  const observedKeys: string[] = []
  const result = await runCandidateCoherenceRetry({
    targetUrl: 'https://stracker.example/',
    expected: {
      sourceSha,
      release: 'controlled-physical-pilot-v1',
      versionId: candidateVersion,
      manifest,
    },
    requestHeaders: { 'Cloudflare-Workers-Version-Key': affinityKey },
    affinityKeyHash: 'affinity-key-hash',
    maxAttempts: states.length,
    initialDelayMs: 0,
    maxTotalWaitMs: 90_000,
    fetchImpl: candidateFetch(states, observedKeys),
    sleep: async () => undefined,
    log: (line) => logs.push(line),
    ...extra,
  })
  return { result, logs, observedKeys }
}

describe('Santa Fe query-range release contract', () => {
  test('uses an explicit bounded query transport for PMTiles', () => {
    const archive = new URL(manifest.asset_paths[0], 'https://stracker.example').toString()
    const url = pmtilesQueryRangeUrl(archive, 127, 4096)
    expect(url.searchParams.get(PMTILES_OFFSET_PARAM)).toBe('127')
    expect(url.searchParams.get(PMTILES_LENGTH_PARAM)).toBe('4096')
    expect(url.origin).toBe('https://stracker.example')
  })

  test('serves an exact binary slice and rejects unbounded access', async () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, index) => index)
    const path = manifest.asset_paths[0]
    const assets = {
      async fetch(request: Request): Promise<Response> {
        expect(new URL(request.url).search).toBe('')
        expect(request.headers.get('Range')).toBeNull()
        return new Response(bytes, { status: 200, headers: { ETag: '"fixture"' } })
      },
    }
    const query = new URL(path, 'https://stracker.example')
    query.searchParams.set(PMTILES_OFFSET_PARAM, '8')
    query.searchParams.set(PMTILES_LENGTH_PARAM, '16')
    const response = await handleMinimumRuntimeRequest(
      new Request(query, { headers: { Range: 'bytes=8-23' } }),
      { ASSETS: assets },
    )
    expect(response.status).toBe(206)
    expect(response.headers.get('x-stracker-pmtiles-transport')).toBe(PMTILES_QUERY_TRANSPORT)
    expect(response.headers.get('content-range')).toBe('bytes 8-23/64')
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(bytes.slice(8, 24)))

    const unbounded = await handleMinimumRuntimeRequest(
      new Request(new URL(path, 'https://stracker.example')),
      { ASSETS: assets },
    )
    expect(unbounded.status).toBe(400)
  })

  test('retries when version metadata is candidate but build.json is old', async () => {
    const { result } = await runRetry([
      { buildSha: 'b'.repeat(40) },
      {},
    ])
    expect(result.attempts).toBe(2)
    expect(result.firstFailure).toBe('BUILD_JSON_SOURCE_SHA_MISMATCH')
    expect(result.rootCause).toBe('CLOUDFLARE_PROPAGATION_RACE')
  })

  test('classifies a persistent candidate build with the wrong release', async () => {
    let classification: CandidateFailureClassification | null = null
    try {
      await runRetry([{ release: 'wrong-release' }])
    } catch (error) {
      expect(error).toBeInstanceOf(CandidateCoherenceError)
      classification = (error as CandidateCoherenceError).classification
    }
    expect(classification).toBe('BUILD_JSON_RELEASE_MISMATCH')
  })

  test('accepts coherent candidate responses only after several attempts', async () => {
    const { result } = await runRetry([
      { versionSha: 'c'.repeat(40) },
      { manifestExact: false },
      {},
    ])
    expect(result.attempts).toBe(3)
    expect(result.rootCause).toBe('CLOUDFLARE_PROPAGATION_RACE')
    expect(result.finalObservation.classification).toBe('PASS')
  })

  test('requires a stable consecutive coherence streak before browser QA', async () => {
    const { result } = await runRetry([
      {},
      { versionId: 'old-version' },
      {},
      {},
      {},
    ], {
      maxAttempts: 5,
      requiredConsecutivePasses: 3,
    })
    expect(result.attempts).toBe(5)
    expect(result.consecutivePasses).toBe(3)
    expect(result.requiredConsecutivePasses).toBe(3)
    expect(result.rootCause).toBe('CLOUDFLARE_PROPAGATION_RACE')
  })

  test('uses the same affinity key for every retry and sanitizes diagnostics', async () => {
    const { logs, observedKeys } = await runRetry([
      { buildSha: 'd'.repeat(40) },
      {},
    ])
    expect(new Set(observedKeys)).toEqual(new Set([affinityKey]))
    const output = logs.join('\n')
    expect(output).not.toContain(candidateVersion)
    expect(output).not.toContain(affinityKey)
    expect(output).toContain('EXPECTED_VERSION_ID_HASH=')
    expect(output).toContain('AFFINITY_KEY_HASH=affinity-key-hash')
  })

  test('persistent timeout remains a release error with rollback armed', async () => {
    let classification: CandidateFailureClassification | null = null
    try {
      await runRetry([
        { versionId: 'old-version' },
        { versionId: 'old-version' },
      ])
    } catch (error) {
      classification = (error as CandidateCoherenceError).classification
    }
    expect(classification).toBe('VERSION_METADATA_MISMATCH')
    const core = await Bun.file('scripts/release/cloudflare-controlled-physical-pilot-release-core.sh').text()
    expect(core).toContain('trap rollback ERR')
    expect(core).toContain('PUBLIC_ROLLBACK_EXECUTED=YES')
  })

  test('materializes the zero-percent preflight exactly once and never promotes before canary QA', async () => {
    const config = await Bun.file('native-sharing-cloudflare/wrangler.release.jsonc').json()
    expect(config.assets?.run_worker_first || []).toContain('/data/santa-fe-3d/*.pmtiles')
    const wrapper = await Bun.file('scripts/release/cloudflare-controlled-physical-pilot-release.sh').text()
    const core = await Bun.file('scripts/release/cloudflare-controlled-physical-pilot-release-core.sh').text()
    expect(wrapper).toContain('EXPECTED_ONCE_OBSERVED_')
    expect(wrapper).toContain('santa-fe-zero-percent-preflight.ts')
    expect(wrapper).not.toContain("replacement = \"\\necho 'ZERO_PERCENT_DEPLOYMENT_ATTESTATION=PASS'")
    expect(core).toContain('${CANDIDATE_VERSION}@0%')
    expect(core).toContain('${CANDIDATE_VERSION}@1%')
    expect(core).toContain('${CANDIDATE_VERSION}@100%')
    expect(core).toContain('santa-fe-affinity-canary-qa.ts')
    expect(core.indexOf('${CANDIDATE_VERSION}@0%')).toBeLessThan(core.indexOf('${CANDIDATE_VERSION}@1%'))
    expect(core.indexOf('ONE_PERCENT_AFFINITY_SANTA_FE_QA=PASS')).toBeLessThan(core.indexOf('${CANDIDATE_VERSION}@100%'))
  })
})
