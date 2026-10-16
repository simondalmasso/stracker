import { describe, expect, test } from 'bun:test'
import manifest from '../../public/data/santa-fe-3d/manifest.json'
import { handlePublicRuntimeRequest } from '../../native-sharing-cloudflare/src/public-worker.js'

const ORIGIN = 'https://stracker.test'
const path = manifest.asset_paths[0]

function request(offset: number, length: number, range = `bytes=${offset}-${offset + length - 1}`): Request {
  const url = new URL(path, ORIGIN)
  url.searchParams.set('pmtilesOffset', String(offset))
  url.searchParams.set('pmtilesLength', String(length))
  return new Request(url, { headers: { Range: range } })
}

describe('public Worker native PMTiles range transport', () => {
  test('forwards the exact Range to Static Assets and returns only the requested bytes', async () => {
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
    expect(observed).toEqual([{ search: '', range: 'bytes=8-23', acceptEncoding: 'identity' }])
  })

  test('fails closed instead of falling back to a full-file read when Static Assets ignores Range', async () => {
    let calls = 0
    const env = {
      ASSETS: {
        async fetch(): Promise<Response> {
          calls += 1
          return new Response(new Uint8Array(64), { status: 200 })
        },
      },
    }
    const response = await handlePublicRuntimeRequest(request(8, 16), env)
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ status: 'error', error: 'PMTILES_ASSET_RANGE_HTTP_200' })
    expect(calls).toBe(1)
  })

  test('rejects a Range header that disagrees with the bounded query before touching Static Assets', async () => {
    let calls = 0
    const env = {
      ASSETS: {
        async fetch(): Promise<Response> {
          calls += 1
          return new Response(null, { status: 500 })
        },
      },
    }
    const response = await handlePublicRuntimeRequest(request(8, 16, 'bytes=0-15'), env)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ status: 'error', error: 'PMTILES_RANGE_MISMATCH' })
    expect(calls).toBe(0)
  })
})
