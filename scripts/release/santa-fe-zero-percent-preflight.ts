import { createHash } from 'node:crypto'
import manifest from '../../public/data/santa-fe-3d/manifest.json'
import { irreversibleHash, runCandidateCoherenceRetry } from './santa-fe-candidate-coherence'

const targetUrl = process.env.STRACKER_QA_URL || ''
const expectedSha = process.env.STRACKER_EXPECTED_SHA || ''
const expectedVersionId = process.env.STRACKER_EXPECTED_VERSION_ID || ''
const workerName = process.env.STRACKER_PUBLIC_WORKER || 'stracker'
const output = process.env.STRACKER_ZERO_PERCENT_QA_OUTPUT || '/tmp/stracker-zero-percent-override-qa.json'
const SLICE_LENGTH = 16_384

if (!targetUrl || !expectedVersionId) throw new Error('ZERO_PERCENT_PREFLIGHT_ENV_REQUIRED')

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function verifyCandidatePmtilesBytes(): Promise<{ checkedSlices: number; checkedAssets: number }> {
  let checkedSlices = 0
  for (let index = 0; index < manifest.asset_paths.length; index += 1) {
    const assetPath = manifest.asset_paths[index]
    const expectedSize = manifest.asset_sizes[index]
    const expectedAssetSha = manifest.asset_sha256[index]
    if (!assetPath || !Number.isSafeInteger(expectedSize) || expectedSize <= SLICE_LENGTH || !/^[0-9a-f]{64}$/.test(expectedAssetSha || '')) {
      throw new Error('PMTILES_LOCAL_MANIFEST_INVALID')
    }
    const localBytes = new Uint8Array(await Bun.file(`public${assetPath}`).arrayBuffer())
    if (localBytes.byteLength !== expectedSize) throw new Error('PMTILES_LOCAL_SIZE_MISMATCH')
    if (sha256(localBytes) !== expectedAssetSha) throw new Error('PMTILES_LOCAL_SHA_MISMATCH')

    const lastOffset = expectedSize - SLICE_LENGTH
    const middleOffset = Math.floor((expectedSize - SLICE_LENGTH) / 2)
    const offsets = [...new Set([0, middleOffset, lastOffset])]
    for (const offset of offsets) {
      const end = offset + SLICE_LENGTH - 1
      const url = new URL(assetPath, targetUrl)
      url.searchParams.set('pmtilesOffset', String(offset))
      url.searchParams.set('pmtilesLength', String(SLICE_LENGTH))
      const response = await fetch(url, {
        headers: {
          'Cloudflare-Workers-Version-Overrides': `${workerName}="${expectedVersionId}"`,
          'Cache-Control': 'no-cache',
          'Accept-Encoding': 'identity',
          Range: `bytes=${offset}-${end}`,
        },
        cache: 'no-store',
      })
      const remoteBytes = new Uint8Array(await response.arrayBuffer().catch(() => new ArrayBuffer(0)))
      if (response.status !== 206) throw new Error('PMTILES_CANDIDATE_SLICE_HTTP')
      if (response.headers.get('x-stracker-pmtiles-transport') !== 'query-v1') throw new Error('PMTILES_CANDIDATE_SLICE_TRANSPORT')
      if (response.headers.get('content-range') !== `bytes ${offset}-${end}/${expectedSize}`) throw new Error('PMTILES_CANDIDATE_SLICE_CONTENT_RANGE')
      if (remoteBytes.byteLength !== SLICE_LENGTH) throw new Error('PMTILES_CANDIDATE_SLICE_LENGTH')
      const expectedSlice = localBytes.subarray(offset, offset + SLICE_LENGTH)
      if (sha256(remoteBytes) !== sha256(expectedSlice)) throw new Error('PMTILES_CANDIDATE_SLICE_BYTES_MISMATCH')
      checkedSlices += 1
    }
  }
  return { checkedSlices, checkedAssets: manifest.asset_paths.length }
}

const result = await runCandidateCoherenceRetry({
  targetUrl,
  expected: {
    sourceSha: expectedSha,
    release: 'controlled-physical-pilot-v1',
    versionId: expectedVersionId,
    manifest,
  },
  requestHeaders: {
    'Cloudflare-Workers-Version-Overrides': `${workerName}="${expectedVersionId}"`,
    'Cache-Control': 'no-cache',
  },
  maxAttempts: 30,
  initialDelayMs: 2_000,
  maxTotalWaitMs: 90_000,
  requiredConsecutivePasses: 1,
})

const byteProof = await verifyCandidatePmtilesBytes()

const evidence = {
  schema: 'stracker.santa-fe-zero-percent-override-qa.v4',
  sourceSha: expectedSha,
  expectedVersionIdHash: irreversibleHash(expectedVersionId),
  attempts: result.attempts,
  elapsedMs: result.elapsedMs,
  rootCause: result.rootCause,
  firstFailure: result.firstFailure,
  requiredConsecutivePasses: result.requiredConsecutivePasses,
  consecutivePasses: result.consecutivePasses,
  pmtilesByteProof: {
    checkedAssets: byteProof.checkedAssets,
    checkedSlices: byteProof.checkedSlices,
    sliceLength: SLICE_LENGTH,
    offsetsPerAsset: 'START_MIDDLE_END',
    rawBytesRetained: false,
    sliceHashesRetained: false,
  },
  privateDataUsed: false,
  realUserCoordinatesUsed: false,
  coordinateValuesRetained: false,
  rawVersionIdRetained: false,
  authorizationValuesRetained: false,
  gates: {
    VERSION_METADATA_OVERRIDE: 'PASS',
    BUILD_JSON_ASSET_ATTESTATION: 'PASS',
    SANTA_FE_MANIFEST_EXACT: 'PASS',
    PMTILES_QUERY_RANGE_206: 'PASS',
    CONTENT_RANGE_VALID: 'PASS',
    QUERY_TRANSPORT_MARKER: 'PASS',
    PMTILES_CANDIDATE_BYTES_MATCH_COMMITTED_ASSETS: 'PASS',
    PMTILES_CANDIDATE_TOTAL_SIZE_MATCH: 'PASS',
    PMTILES_CANDIDATE_START_MIDDLE_END_SLICES: 'PASS',
    SAME_ATTEMPT_CANDIDATE_COHERENCE: 'PASS',
    BOUNDED_RETRY_MAX_30: 'PASS',
    BOUNDED_RETRY_MAX_90_SECONDS: 'PASS',
    NO_PRIVATE_DATA_IN_ZERO_PERCENT_QA: 'PASS',
  },
}
await Bun.write(output, JSON.stringify(evidence, null, 2) + '\n')
console.log(`ZERO_PERCENT_PMTILES_BYTE_PROOF=PASS assets=${byteProof.checkedAssets} slices=${byteProof.checkedSlices}`)
console.log(`ZERO_PERCENT_OVERRIDE_QA=PASS attempts=${result.attempts} rootCause=${result.rootCause}`)
