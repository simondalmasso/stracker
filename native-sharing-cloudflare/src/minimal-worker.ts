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

const DOCUMENT_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.openfreemap.org; connect-src 'self' https://*.openfreemap.org; font-src 'self' data:; worker-src 'self' blob:; child-src blob:; manifest-src 'self'"
const RELEASE_TAG_PREFIX = 'same-domain-'
const BACKEND_TIMEOUT_MS = 15_000
const SESSION_ID_PATTERN = '[A-Za-z0-9_-]{43}'
const SESSION_ROUTE = new RegExp(`^/api/share/sessions/(${SESSION_ID_PATTERN})(?:/(points|status|rotate-viewer))?$`)
const COOKIE_IMPORT_WINDOW_MS = 60_000
const COOKIE_IMPORT_LIMIT = 20
const cookieImportWindows = new Map<string, { startedAt: number; count: number }>()
const COOKIE_ROUTE = new RegExp(`^/api/cookie-sessions/(${SESSION_ID_PATTERN})(?:/(status|point|refresh))?$`)
const SANTA_FE_PMTILES_ROUTE = /^\/data\/santa-fe-3d\/santa-fe-buildings-3d-[a-z-]+\.[a-f0-9]{16}\.pmtiles$/

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ status: 'error', error }), {
    status,
    headers: API_HEADERS,
  })
}

function runtimeVersionInfo(env: MinimalRuntimeEnv): Response | null {
  const metadata = env.CF_VERSION_METADATA
  const tag = metadata?.tag || ''
  const sourceSha = tag.startsWith(RELEASE_TAG_PREFIX) ? tag.slice(RELEASE_TAG_PREFIX.length) : ''
  if (!metadata?.id || !/^[0-9a-f]{40}$/.test(sourceSha)) return null
  return new Response(JSON.stringify({ sourceSha, versionId: metadata.id, versionTag: tag }), {
    status: 200,
    headers: API_HEADERS,
  })
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
  if (
    url.pathname === '/' ||
    url.pathname === '/share' ||
    url.pathname === '/share/' ||
    url.pathname === '/shared' ||
    url.pathname === '/shared/' ||
    url.pathname === '/__stracker/build.json'
  ) {
    headers.set('Cache-Control', 'no-store, max-age=0')
    headers.set('Pragma', 'no-cache')
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

async function serveSantaFePmtiles(request: Request, env: MinimalRuntimeEnv, url: URL): Promise<Response> {
  if (url.search) return jsonError(400, 'REQUEST_INVALID')
  if (request.method !== 'GET' && request.method !== 'HEAD') return jsonError(405, 'METHOD_NOT_ALLOWED')
  if (!env.ASSETS) return jsonError(503, 'ASSET_BINDING_UNAVAILABLE')

  const assetHeaders = new Headers(request.headers)
  assetHeaders.delete('Range')
  assetHeaders.delete('If-Range')
  assetHeaders.delete('Authorization')
  assetHeaders.delete('Cookie')
  assetHeaders.set('Accept-Encoding', 'identity')
  const assetRequest = new Request(url.toString(), {
    method: 'GET',
    headers: assetHeaders,
  })

  try {
    const asset = await env.ASSETS.fetch(assetRequest)
    if (asset.status !== 200) return jsonError(asset.status === 404 ? 404 : 503, asset.status === 404 ? 'NOT_FOUND' : 'ASSET_UNAVAILABLE')
    const headers = new Headers(asset.headers)
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    headers.set('Content-Type', 'application/vnd.pmtiles')
    headers.set('Content-Disposition', 'inline')
    headers.set('Referrer-Policy', 'no-referrer')
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.delete('Content-Security-Policy')
    headers.delete('Permissions-Policy')
    return new Response(request.method === 'HEAD' ? null : asset.body, {
      status: 200,
      statusText: asset.statusText,
      headers,
    })
  } catch {
    return jsonError(503, 'ASSET_UNAVAILABLE')
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
    case 'refresh': return ['POST']
    case 'session': return ['DELETE']
    default: return null
  }
}

function cookieImportRateLimit(request: Request): Response | null {
  const key = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',', 1)[0]?.trim() || 'unknown'
  const now = Date.now()
  if (cookieImportWindows.size > 1_024) {
    for (const [candidate, window] of cookieImportWindows) {
      if (now - window.startedAt >= COOKIE_IMPORT_WINDOW_MS) cookieImportWindows.delete(candidate)
    }
  }
  const current = cookieImportWindows.get(key)
  if (!current || now - current.startedAt >= COOKIE_IMPORT_WINDOW_MS) {
    cookieImportWindows.set(key, { startedAt: now, count: 1 })
    return null
  }
  if (current.count >= COOKIE_IMPORT_LIMIT) {
    const response = jsonError(429, 'FREQUENCY_LIMIT')
    response.headers.set('Retry-After', String(Math.max(1, Math.ceil((COOKIE_IMPORT_WINDOW_MS - (now - current.startedAt)) / 1000))))
    return response
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
  if (url.search) return jsonError(400, 'REQUEST_INVALID')
  const allowed = url.pathname.startsWith('/api/cookie-sessions')
    ? allowedCookieMethods(url.pathname)
    : allowedNativeMethods(url.pathname)
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
  if (url.pathname.startsWith('/api/share/') || url.pathname.startsWith('/api/cookie-sessions')) {
    return forwardApi(request, env, url)
  }
  if ((url.pathname === '/shared' || url.pathname === '/shared/') && url.search) return jsonError(400, 'REQUEST_INVALID')
  if (!env.ASSETS) return jsonError(503, 'ASSET_BINDING_UNAVAILABLE')
  try {
    return hardenAssetResponse(request, await env.ASSETS.fetch(request))
  } catch {
    return jsonError(503, 'ASSET_UNAVAILABLE')
  }
}

export default {
  fetch(request: Request, env: MinimalRuntimeEnv): Promise<Response> {
    return handleMinimumRuntimeRequest(request, env)
  },
} satisfies ExportedHandler<MinimalRuntimeEnv>
