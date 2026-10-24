import { describe, expect, test } from 'bun:test'
import manifest from '../../public/data/santa-fe-3d/manifest.json'
import { handlePublicRuntimeRequest } from '../../native-sharing-cloudflare/src/public-worker.js'

const ORIGIN = 'https://stracker.test'
const path = manifest.asset_paths[0]

function request(offset: number, length: number, range = `bytes=${offset}-${offset + length - 1}`): Request {
  const url = new URL(path, ORIGIN)
  url.searchParams.set('pmtilesOffset', String(offset))
  url.searchParams.set('pmtilesLength', String(length))
  return new Request(url, { headers: { Range: range, 'Accept-Encoding': 'identity' } })
}

describe('public Worker PMTiles static-asset pass-through', () => {
  test('passes the bounded range and query directly to Static Assets without buffering or re-slicing', async () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, index) => index)
    const observed: Array<{ search: string; range: string | null; acceptEncoding: string | null }> = []
    const env = {
      ASSETS: {
        async fetch(assetRequest: Request): Promise<Response> {
          const url = new URL(assetRequest.url)
          observed.push({
            search: url.search,
            range: assetRequest.headers.get('Range'),
            acceptEncoding: assetRequest.headers.get('Accept-Encoding'),
          })
          return new Response(bytes.slice(8, 24), {
            status: 206,
            headers: {
              'Accept-Ranges': 'bytes',
              'Content-Length': '16',
              'Content-Range': 'bytes 8-23/64',
              'Content-Type': 'application/vnd.pmtiles',
              'X-Stracker-PMTiles-Transport': 'query-v1',
              ETag: '"fixture-pmtiles"',
            },
          })
        },
      },
    }

    const response = await handlePublicRuntimeRequest(request(8, 16), env)
    expect(response.status).toBe(206)
    expect(response.headers.get('x-stracker-pmtiles-transport')).toBe('query-v1')
    expect(response.headers.get('content-range')).toBe('bytes 8-23/64')
    expect(response.headers.get('content-length')).toBe('16')
    expect(response.headers.get('etag')).toBe('"fixture-pmtiles"')
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(bytes.slice(8, 24)))
    expect(observed).toEqual([{
      search: '?pmtilesOffset=8&pmtilesLength=16',
      range: 'bytes=8-23',
      acceptEncoding: 'identity',
    }])
  })

  test('never upgrades a full-asset 200 into a fabricated partial 206', async () => {
    const bytes = new Uint8Array(64)
    let calls = 0
    const env = {
      ASSETS: {
        async fetch(): Promise<Response> {
          calls += 1
          return new Response(bytes, { status: 200 })
        },
      },
    }
    const response = await handlePublicRuntimeRequest(request(8, 16), env)
    expect(response.status).toBe(200)
    expect((await response.arrayBuffer()).byteLength).toBe(64)
    expect(calls).toBe(1)
  })
})
