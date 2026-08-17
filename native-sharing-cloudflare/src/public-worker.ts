import { COOKIE_POLICY_VERSION, parseCookieSession } from './cookie-session.js'
import { handleMinimumRuntimeRequest } from './minimal-worker.js'

type MinimalRuntimeEnv = Parameters<typeof handleMinimumRuntimeRequest>[1]

const COOKIE_IMPORT_PATH = '/api/cookie-sessions'
const PMTILES_PATH_RE = /^\/data\/santa-fe-3d\/santa-fe-buildings-3d-[a-z-]+\.[0-9a-f]{16}\.pmtiles$/
const PMTILES_OFFSET_PARAM = 'pmtilesOffset'
const PMTILES_LENGTH_PARAM = 'pmtilesLength'
const PMTILES_MAX_RANGE_BYTES = 4 * 1024 * 1024
const ERROR_STATUS: Record<string, number> = {
  COOKIE_FORMAT_UNRECOGNIZED: 400,
  COOKIE_INVALID: 400,
  COOKIE_DOMAIN_REJECTED: 400,
  COOKIE_SET_INCOMPLETE: 400,
  COOKIE_AUTH_EXPIRED: 401,
  BODY_TOO_LARGE: 413,
}

function safeError(error: unknown): Response {
  const code = error instanceof Error && ERROR_STATUS[error.message] ? error.message : 'REQUEST_INVALID'
  return new Response(JSON.stringify({ status: 'error', error: code }), {
    status: ERROR_STATUS[code] ?? 400,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Type': 'application/json; charset=utf-8',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function pmtilesError(status: number, code: string): Response {
  return new Response(JSON.stringify({ status: 'error', error: code }), {
    status,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Content-Type': 'application/json; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

function exactUnsigned(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function sameOriginRequest(request: Request, url: URL): boolean {
  const origin = request.headers.get('Origin')
  if (origin && origin !== url.origin) return false
  return request.headers.get('Sec-Fetch-Site') !== 'cross-site'
}

function serializedRetainedCookies(raw: string): {
  raw: string
  totalParsed: number
  expiredDropped: number
  retainedCount: number
} {
  const parsed = parseCookieSession(raw)
  return {
    raw: JSON.stringify(parsed.cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      expirationDate: cookie.expiresAt,
    }))),
    totalParsed: parsed.totalParsed,
    expiredDropped: parsed.expiredDropped,
    retainedCount: parsed.retainedCount,
  }
}

async function importWithExpiryFilter(request: Request, env: MinimalRuntimeEnv, url: URL): Promise<Response> {
  if (!sameOriginRequest(request, url) || url.search) return handleMinimumRuntimeRequest(request, env)
  const payload = await request.clone().json().catch(() => null) as { raw?: unknown; durationMs?: unknown } | null
  if (!payload || typeof payload.raw !== 'string') return handleMinimumRuntimeRequest(request, env)

  let retained: ReturnType<typeof serializedRetainedCookies>
  try {
    retained = serializedRetainedCookies(payload.raw)
  } catch (error) {
    return safeError(error)
  }

  const headers = new Headers(request.headers)
  headers.delete('content-length')
  headers.set('Content-Type', 'application/json')
  const downstream = new Request(request.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...payload, raw: retained.raw }),
  })
  const response = await handleMinimumRuntimeRequest(downstream, env)
  if (!response.ok) return response
  const metadata = await response.clone().json().catch(() => null) as Record<string, unknown> | null
  if (!metadata) return response
  const responseHeaders = new Headers(response.headers)
  responseHeaders.set('Cache-Control', 'no-store, max-age=0')
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify({
    ...metadata,
    policyVersion: COOKIE_POLICY_VERSION,
    totalParsed: retained.totalParsed,
    expiredDropped: retained.expiredDropped,
    retainedCount: retained.retainedCount,
  }), { status: response.status, statusText: response.statusText, headers: responseHeaders })
}

async function servePmtilesNativeRange(request: Request, env: MinimalRuntimeEnv, url: URL): Promise<Response> {
  if (request.method !== 'GET') return pmtilesError(405, 'METHOD_NOT_ALLOWED')
  if (!env.ASSETS) return pmtilesError(503, 'ASSET_BINDING_UNAVAILABLE')
  if ([...url.searchParams.keys()].length !== 2) return pmtilesError(400, 'PMTILES_QUERY_INVALID')

  const offset = exactUnsigned(url.searchParams.get(PMTILES_OFFSET_PARAM))
  const length = exactUnsigned(url.searchParams.get(PMTILES_LENGTH_PARAM))
  if (offset === null || length === null || length <= 0 || length > PMTILES_MAX_RANGE_BYTES) {
    return pmtilesError(400, 'PMTILES_QUERY_INVALID')
  }
  const end = offset + length - 1
  if (!Number.isSafeInteger(end) || end < offset) return pmtilesError(400, 'PMTILES_QUERY_INVALID')
  const expectedRange = `bytes=${offset}-${end}`
  if (request.headers.get('Range') !== expectedRange) return pmtilesError(400, 'PMTILES_RANGE_MISMATCH')

  const canonical = new URL(url)
  canonical.search = ''
  canonical.hash = ''
  const assetHeaders = new Headers()
  assetHeaders.set('Range', expectedRange)
  assetHeaders.set('Accept', 'application/vnd.pmtiles, application/octet-stream')
  assetHeaders.set('Accept-Encoding', 'identity')
  const assetResponse = await env.ASSETS.fetch(new Request(canonical.toString(), { method: 'GET', headers: assetHeaders }))
  if (assetResponse.status !== 206) return pmtilesError(502, `PMTILES_ASSET_RANGE_HTTP_${assetResponse.status}`)

  const contentRange = assetResponse.headers.get('Content-Range') || ''
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange)
  const total = match ? Number(match[3]) : NaN
  if (
    !match
    || Number(match[1]) !== offset
    || Number(match[2]) !== end
    || !Number.isSafeInteger(total)
    || total <= end
  ) return pmtilesError(502, 'PMTILES_ASSET_CONTENT_RANGE_INVALID')

  const bytes = await assetResponse.arrayBuffer()
  if (bytes.byteLength !== length) return pmtilesError(502, 'PMTILES_ASSET_RANGE_LENGTH_MISMATCH')

  const headers = new Headers()
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Content-Length', String(length))
  headers.set('Content-Range', contentRange)
  headers.set('Content-Type', assetResponse.headers.get('Content-Type') || 'application/vnd.pmtiles')
  headers.set('X-Stracker-PMTiles-Transport', 'query-v1')
  for (const name of ['Cache-Control', 'ETag', 'Expires', 'Last-Modified']) {
    const value = assetResponse.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(bytes, { status: 206, headers })
}

export async function handlePublicRuntimeRequest(request: Request, env: MinimalRuntimeEnv): Promise<Response> {
  const url = new URL(request.url)
  if (PMTILES_PATH_RE.test(url.pathname)) {
    return servePmtilesNativeRange(request, env, url)
  }
  if (url.pathname === COOKIE_IMPORT_PATH && request.method === 'POST') {
    return importWithExpiryFilter(request, env, url)
  }
  return handleMinimumRuntimeRequest(request, env)
}

export default {
  fetch(request: Request, env: MinimalRuntimeEnv): Promise<Response> {
    return handlePublicRuntimeRequest(request, env)
  },
} satisfies ExportedHandler<MinimalRuntimeEnv>
