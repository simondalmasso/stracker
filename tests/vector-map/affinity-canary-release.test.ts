import { describe, expect, test } from 'bun:test'
import manifest from '../../public/data/santa-fe-3d/manifest.json'
import { handleMinimumRuntimeRequest } from '../../native-sharing-cloudflare/src/minimal-worker'
import {
  PMTILES_LENGTH_PARAM,
  PMTILES_OFFSET_PARAM,
  PMTILES_QUERY_TRANSPORT,
  pmtilesQueryRangeUrl,
} from '../../src/lib/location-source/map-engine/pmtiles-query-source'

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

  test('keeps PMTiles worker-first and stages affinity before promotion', async () => {
    const config = await Bun.file('native-sharing-cloudflare/wrangler.release.jsonc').json()
    expect(config.assets?.run_worker_first || []).toContain('/data/santa-fe-3d/*.pmtiles')
    const release = await Bun.file('scripts/release/cloudflare-controlled-physical-pilot-release.sh').text()
    expect(release).toContain('${CANDIDATE_VERSION}@0%')
    expect(release).toContain('${CANDIDATE_VERSION}@1%')
    expect(release).toContain('${CANDIDATE_VERSION}@100%')
    expect(release).toContain('santa-fe-affinity-canary-qa.ts')
    expect(release.indexOf('${CANDIDATE_VERSION}@1%')).toBeLessThan(release.indexOf('${CANDIDATE_VERSION}@100%'))
  })
})
