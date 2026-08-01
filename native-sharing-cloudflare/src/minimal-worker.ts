interface AssetsBinding {
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
const RELEASE_LABEL = 'same-domain-minimum-usable-v1'
const RELEASE_TAG_PREFIX = 'same-domain-'

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ status: 'error', error }), {
    status,
    headers: API_HEADERS,
  })
}

function runtimeBuildInfo(env: MinimalRuntimeEnv): Response | null {
  const metadata = env.CF_VERSION_METADATA
  const tag = metadata?.tag || ''
  const sourceSha = tag.startsWith(RELEASE_TAG_PREFIX)
    ? tag.slice(RELEASE_TAG_PREFIX.length)
    : ''
  if (!metadata?.id || !/^[0-9a-f]{40}$/.test(sourceSha)) return null
  return new Response(JSON.stringify({
    sourceSha,
    release: RELEASE_LABEL,
    versionId: metadata.id,
    versionTag: tag,
  }), {
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
    url.pathname === '/shared' ||
    url.pathname === '/shared/' ||
    url.pathname === '/__stracker/build.json'
  ) {
    headers.set('Cache-Control', 'no-store, max-age=0')
    headers.set('Pragma', 'no-cache')
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export async function handleMinimumRuntimeRequest(
  request: Request,
  env: MinimalRuntimeEnv,
): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/__stracker/build.json') {
    const buildInfo = runtimeBuildInfo(env)
    if (buildInfo) return buildInfo
  }
  if (url.pathname.startsWith('/api/share/')) {
    return jsonError(503, 'SHARED_LOCATION_NOT_AVAILABLE')
  }
  if ((url.pathname === '/shared' || url.pathname === '/shared/') && url.search) {
    return jsonError(400, 'REQUEST_INVALID')
  }
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
