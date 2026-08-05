import { EtagMismatch, type RangeResponse, type Source } from 'pmtiles'

export const PMTILES_OFFSET_PARAM = 'pmtilesOffset'
export const PMTILES_LENGTH_PARAM = 'pmtilesLength'
export const PMTILES_QUERY_TRANSPORT = 'query-v1'
export const PMTILES_MAX_RANGE_BYTES = 4 * 1024 * 1024

function exactInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`INVALID_${name}`)
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

export function pmtilesQueryRangeUrl(archiveUrl: string, offset: number, length: number): URL {
  exactInteger(offset, 'PMTILES_OFFSET')
  exactInteger(length, 'PMTILES_LENGTH')
  if (length <= 0 || length > PMTILES_MAX_RANGE_BYTES) throw new Error('INVALID_PMTILES_LENGTH')
  const url = new URL(archiveUrl)
  if (url.search || url.hash) throw new Error('PMTILES_ARCHIVE_URL_MUST_BE_CANONICAL')
  url.searchParams.set(PMTILES_OFFSET_PARAM, String(offset))
  url.searchParams.set(PMTILES_LENGTH_PARAM, String(length))
  return url
}

export class SameOriginQueryRangeSource implements Source {
  readonly archiveUrl: string
  private readonly origin: string

  constructor(archiveUrl: string, expectedOrigin: string) {
    const canonical = new URL(archiveUrl)
    const origin = new URL(expectedOrigin).origin
    if (canonical.origin !== origin) throw new Error('PMTILES_SOURCE_MUST_BE_SAME_ORIGIN')
    if (canonical.search || canonical.hash) throw new Error('PMTILES_SOURCE_URL_MUST_BE_CANONICAL')
    this.archiveUrl = canonical.toString()
    this.origin = origin
  }

  getKey(): string {
    return this.archiveUrl
  }

  async getBytes(offset: number, length: number, signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
    const url = pmtilesQueryRangeUrl(this.archiveUrl, offset, length)
    if (url.origin !== this.origin) throw new Error('PMTILES_RANGE_ORIGIN_DRIFT')
    const end = offset + length - 1
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.pmtiles, application/octet-stream',
        Range: `bytes=${offset}-${end}`,
      },
      cache: 'force-cache',
      credentials: 'same-origin',
      signal,
    })
    if (response.status !== 206) throw new Error(`PMTILES_QUERY_RANGE_HTTP_${response.status}`)
    if (!isLoopback(url.hostname) && response.headers.get('x-stracker-pmtiles-transport') !== PMTILES_QUERY_TRANSPORT) {
      throw new Error('PMTILES_QUERY_RANGE_TRANSPORT_MISSING')
    }
    const contentRange = response.headers.get('content-range') || ''
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange)
    if (!match || Number(match[1]) !== offset || Number(match[2]) !== end || Number(match[3]) <= end) {
      throw new Error('PMTILES_QUERY_RANGE_CONTENT_RANGE_INVALID')
    }
    const data = await response.arrayBuffer()
    if (data.byteLength !== length) throw new Error('PMTILES_QUERY_RANGE_LENGTH_MISMATCH')
    const nextEtag = response.headers.get('etag') || undefined
    if (etag && nextEtag && etag !== nextEtag) throw new EtagMismatch('PMTILES_QUERY_RANGE_ETAG_MISMATCH')
    return {
      data,
      etag: nextEtag,
      cacheControl: response.headers.get('cache-control') || undefined,
      expires: response.headers.get('expires') || undefined,
    }
  }
}
