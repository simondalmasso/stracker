interface AssetsBinding {
  fetch(request: Request): Promise<Response>
}

interface ServiceBinding {
  fetch(request: Request): Promise<Response>
}

interface VersionMetadataBinding {
  id: string
  tag?: string
  timestamp: string
}

interface MinimalRuntimeEnv {
  ASSETS?: AssetsBinding
  CF_VERSION_METADATA?: VersionMetadataBinding
  NATIVE_SHARING_BACKEND?: ServiceBinding
}

const API_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const

const DOCUMENT_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.openfreemap.org https://tiles.maps.eox.at; connect-src 'self' https://*.openfreemap.org https://tiles.maps.eox.at; font-src 'self' data:; worker-src 'self' blob:; child-src blob:; manifest-src 'self'"
const RELEASE_TAG_PREFIX = 'same-domain-'
const BACKEND_TIMEOUT_MS = 15_000
const SESSION_ID_PATTERN = '[A-Za-z0-9_-]{43}'
const SESSION_ROUTE = new RegExp(`^/api/share/sessions/(${SESSION_ID_PATTERN})(?:/(points|status|rotate-viewer))?$`)
const COOKIE_IMPORT_WINDOW_MS = 60_000
const COOKIE_IMPORT_LIMIT = 20
const cookieImportWindows = new Map<string, { startedAt: number; count: number }>()
const COOKIE_ROUTE = new RegExp(`^/api/cookie-sessions/(${SESSION_ID_PATTERN})(?:/(status|point|history|refresh|mobility-memory))?$`)
const SANTA_FE_PMTILES_ROUTE = /^\/data\/santa-fe-3d\/santa-fe-buildings-3d-[a-z-]+\.[a-f0-9]{16}\.pmtiles$/
const PMTILES_OFFSET_PARAM = 'pmtilesOffset'
const PMTILES_LENGTH_PARAM = 'pmtilesLength'
const PMTILES_MAX_RANGE_BYTES = 4 * 1024 * 1024
const PMTILES_MAX_ARCHIVE_BYTES = 25 * 1024 * 1024
const PMTILES_TRANSPORT = 'query-v1'

interface CachedPmtilesAsset {
  bytes: ArrayBuffer
  etag?: string
}
const pmtilesAssetCache = new Map<string, Promise<CachedPmtilesAsset>>()

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ status: 'error', error }), { status, headers: API_HEADERS })
}

function runtimeVersionInfo(env: MinimalRuntimeEnv): Response | null {
  const metadata = env.CF_VERSION_METADATA
  const tag = metadata?.tag || ''
  const sourceSha = tag.startsWith(RELEASE_TAG_PREFIX) ? tag.slice(RELEASE_TAG_PREFIX.length) : ''
  if (!metadata?.id || !/^[0-9a-f]{40}$/.test(sourceSha)) return null
  return new Response(JSON.stringify({ sourceSha, versionId: metadata.id, versionTag: tag }), { status: 200, headers: API_HEADERS })
}

function hardenAssetResponse(request: Request, response: Response): Response {
  const url = new URL(request.url)
  const headers = new Headers(response.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('Content-Security-Policy', DOCUMENT_CSP)
  headers.set('Permissions-Policy', url.pathname === '/shared' || url.pathname === '/shared/'
    ? 'geolocation=(), camera=(), microphone=()'
    : 'geolocation=(self), camera=(), microphone=()')
  if (url.pathname === '/' || url.pathname === '/share' || url.pathname === '/share/' || url.pathname === '/shared' || url.pathname === '/shared/' || url.pathname === '/__stracker/build.json') {
    headers.set('Cache-Control', 'no-store, max-age=0')
    headers.set('Pragma', 'no-cache')
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function parseExactUnsignedInteger(value: string | null): number | null {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function pmtilesQueryRange(url: URL, request: Request): { offset: number; length: number } | null {
  if (url.searchParams.size !== 2) return null
  if (url.searchParams.getAll(PMTILES_OFFSET_PARAM).length !== 1 || url.searchParams.getAll(PMTILES_LENGTH_PARAM).length !== 1) return null
  const offset = parseExactUnsignedInteger(url.searchParams.get(PMTILES_OFFSET_PARAM))
  const length = parseExactUnsignedInteger(url.searchParams.get(PMTILES_LENGTH_PARAM))
  if (offset === null || length === null || length <= 0 || length > PMTILES_MAX_RANGE_BYTES) return null
  const end = offset + length - 1
  if (!Number.isSafeInteger(end)) return null
  const rangeHeader = request.headers.get('Range')
  if (rangeHeader && rangeHeader !== `bytes=${offset}-${end}`) return null
  return { offset, length }
}

async function loadPmtilesAsset(env: MinimalRuntimeEnv, url: URL): Promise<CachedPmtilesAsset> {
  if (!env.ASSETS) throw new Error('ASSET_BINDING_UNAVAILABLE')
  const key = url.pathname
  const existing = pmtilesAssetCache.get(key)
  if (existing) return existing
  const promise = (async () => {
    const canonical = new URL(url)
    canonical.search = ''
    canonical.hash = ''
    const response = await env.ASSETS!.fetch(new Request(canonical.toString(), { method: 'GET', headers: { 'Accept-Encoding': 'identity' } }))
    if (response.status !== 200) throw new Error(response.status === 404 ? 'NOT_FOUND' : 'ASSET_UNAVAILABLE')
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength <= 0 || bytes.byteLength >= PMTILES_MAX_ARCHIVE_BYTES) throw new Error('ASSET_SIZE_INVALID')
    return { bytes, etag: response.headers.get('etag') || undefined }
  })()
  pmtilesAssetCache.set(key, promise)
  try { return await promise } catch (error) { pmtilesAssetCache.delete(key); throw error }
}

async function serveSantaFePmtiles(request: Request, env: MinimalRuntimeEnv, url: URL): Promise<Response> {
  if (request.method !== 'GET') return jsonError(405, 'METHOD_NOT_ALLOWED')
  const requested = pmtilesQueryRange(url, request)
  if (!requested) return jsonError(400, 'PMTILES_QUERY_RANGE_REQUIRED')
  try {
    const asset = await loadPmtilesAsset(env, url)
    const endExclusive = requested.offset + requested.length
    if (requested.offset >= asset.bytes.byteLength || endExclusive > asset.bytes.byteLength) {
      return new Response(null, { status: 416, headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${asset.bytes.byteLength}`, 'Cache-Control': 'no-store', 'X-Stracker-PMTiles-Transport': PMTILES_TRANSPORT } })
    }
    const end = endExclusive - 1
    const body = asset.bytes.slice(requested.offset, endExclusive)
    const headers = new Headers({ 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Disposition': 'inline', 'Content-Length': String(body.byteLength), 'Content-Range': `bytes ${requested.offset}-${end}/${asset.bytes.byteLength}`, 'Content-Type': 'application/vnd.pmtiles', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Stracker-PMTiles-Transport': PMTILES_TRANSPORT })
    if (asset.etag) headers.set('ETag', asset.etag)
    return new Response(body, { status: 206, headers })
  } catch (error) {
    const code = error instanceof Error ? error.message : 'ASSET_UNAVAILABLE'
    if (code === 'NOT_FOUND') return jsonError(404, 'NOT_FOUND')
    if (code === 'ASSET_BINDING_UNAVAILABLE') return jsonError(503, code)
    return jsonError(503, code === 'ASSET_SIZE_INVALID' ? code : 'ASSET_UNAVAILABLE')
  }
}

function allowedNativeMethods(pathname: string): readonly string[] | null {
  if (pathname === '/api/share/sessions') return ['POST']
  if (pathname === '/api/share/viewer/exchange') return ['POST']
  if (pathname === '/api/share/viewer/logout') return ['POST']
  const match = SESSION_ROUTE.exec(pathname)
  if (!match) return null
  switch (match[2] || 'session') {
    case 'points': return ['GET', 'POST']
    case 'status': return ['GET']
    case 'rotate-viewer': return ['POST']
    case 'session': return ['DELETE']
    default: return null
  }
}

function allowedCookieMethods(pathname: string): readonly string[] | null {
  if (pathname === '/api/cookie-sessions') return ['POST']
  const match = COOKIE_ROUTE.exec(pathname)
  if (!match) return null
  switch (match[2] || 'session') {
    case 'status': return ['GET']
    case 'point': return ['GET']
    case 'history': return ['GET']
    case 'refresh': return ['POST']
    case 'mobility-memory': return ['DELETE']
    case 'session': return ['DELETE']
    default: return null
  }
}

function historyQueryValid(url: URL): boolean {
  if (!/\/history$/.test(url.pathname)) return url.searchParams.size === 0
  if (url.searchParams.size !== 1 || url.searchParams.getAll('since').length !== 1) return false
  return Number.isFinite(Date.parse(url.searchParams.get('since') || ''))
}

function cookieImportRateLimit(request: Request): Response | null {
  const key = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',', 1)[0]?.trim() || 'unknown'
  const now = Date.now()
  if (cookieImportWindows.size > 1_024) {
    for (const [candidate, window] of cookieImportWindows) if (now - window.startedAt >= COOKIE_IMPORT_WINDOW_MS) cookieImportWindows.delete(candidate)
  }
  const current = cookieImportWindows.get(key)
  if (!current || now - current.startedAt >= COOKIE_IMPORT_WINDOW_MS) {
    cookieImportWindows.set(key, { startedAt: now, count: 1 })
    return null
  }
  if (current.count >= COOKIE_IMPORT_LIMIT) {
    const limited = jsonError(429, 'FREQUENCY_LIMIT')
    limited.headers.set('Retry-After', String(Math.max(1, Math.ceil((COOKIE_IMPORT_WINDOW_MS - (now - current.startedAt)) / 1000))))
    return limited
  }
  current.count += 1
  return null
}

function ensureSameOrigin(request: Request, url: URL): Response | null {
  const origin = request.headers.get('Origin')
  if (origin && origin !== url.origin) return jsonError(403, 'ORIGIN_REJECTED')
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return jsonError(403, 'ORIGIN_REJECTED')
  return null
}

async function forwardApi(request: Request, env: MinimalRuntimeEnv, url: URL): Promise<Response> {
  const cookieApi = url.pathname.startsWith('/api/cookie-sessions')
  if (cookieApi ? !historyQueryValid(url) : Boolean(url.search)) return jsonError(400, 'REQUEST_INVALID')
  const allowed = cookieApi ? allowedCookieMethods(url.pathname) : allowedNativeMethods(url.pathname)
  if (!allowed) return jsonError(404, 'NOT_FOUND')
  if (!allowed.includes(request.method)) return jsonError(405, 'METHOD_NOT_ALLOWED')
  const originError = ensureSameOrigin(request, url)
  if (originError) return originError
  if (url.pathname === '/api/cookie-sessions' && request.method === 'POST') {
    const rateLimit = cookieImportRateLimit(request)
    if (rateLimit) return rateLimit
  }
  if (!env.NATIVE_SHARING_BACKEND) return jsonError(503, 'BINDING_UNAVAILABLE')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort('BACKEND_TIMEOUT'), BACKEND_TIMEOUT_MS)
  try {
    const downstream = new Request(request, { signal: controller.signal })
    return await env.NATIVE_SHARING_BACKEND.fetch(downstream)
  } catch {
    return jsonError(controller.signal.aborted ? 504 : 503, controller.signal.aborted ? 'OPERATION_TIMEOUT' : 'STORAGE_UNAVAILABLE')
  } finally {
    clearTimeout(timeout)
  }
}

export async function handleMinimumRuntimeRequest(request: Request, env: MinimalRuntimeEnv): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/__stracker/version.json') {
    const versionInfo = runtimeVersionInfo(env)
    return versionInfo || jsonError(503, 'VERSION_METADATA_UNAVAILABLE')
  }
  if (SANTA_FE_PMTILES_ROUTE.test(url.pathname)) return serveSantaFePmtiles(request, env, url)
  if (url.pathname.startsWith('/api/share/') || url.pathname.startsWith('/api/cookie-sessions')) return forwardApi(request, env, url)
  if ((url.pathname === '/shared' || url.pathname === '/shared/') && url.search) return jsonError(400, 'REQUEST_INVALID')
  if (!env.ASSETS) return jsonError(503, 'ASSET_BINDING_UNAVAILABLE')
  try { return hardenAssetResponse(request, await env.ASSETS.fetch(request)) } catch { return jsonError(503, 'ASSET_UNAVAILABLE') }
}

export default {
  fetch(request: Request, env: MinimalRuntimeEnv): Promise<Response> {
    return handleMinimumRuntimeRequest(request, env)
  },
} satisfies ExportedHandler<MinimalRuntimeEnv>
