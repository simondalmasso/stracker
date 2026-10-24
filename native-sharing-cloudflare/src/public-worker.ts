import { COOKIE_POLICY_VERSION, parseCookieSession } from './cookie-session.js'
import { handleMinimumRuntimeRequest } from './minimal-worker.js'

type MinimalRuntimeEnv = Parameters<typeof handleMinimumRuntimeRequest>[1]

const COOKIE_IMPORT_PATH = '/api/cookie-sessions'
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

export async function handlePublicRuntimeRequest(request: Request, env: MinimalRuntimeEnv): Promise<Response> {
  const url = new URL(request.url)
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
