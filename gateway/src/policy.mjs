export const GATEWAY_MARKER = 'private-poc-v1'
export const MAX_REQUEST_BYTES = 512 * 1024
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const STAGING_SCENARIOS = Object.freeze([
  'session_valid', 'session_absent', 'session_expired',
  'location_fresh', 'location_stale', 'no_location', 'timeout', 'upstream_error', 'redirect', 'set_cookie',
])

const routeList = [
  { method: 'GET', path: '/api/session/status', upstreamPath: '/api/session/status', body: 'none' },
  { method: 'POST', path: '/api/session/import', upstreamPath: '/api/session/import', body: 'json' },
  { method: 'POST', path: '/api/session/delete', upstreamPath: '/api/session/delete', body: 'none' },
  { method: 'GET', path: '/points', upstreamPath: '/points', body: 'none' },
]

export const ROUTES = Object.freeze(routeList)
export function findRoute(method, pathname) { return ROUTES.find((route) => route.method === method && route.path === pathname) || null }
export function allowedMethods(pathname) { return ROUTES.filter((route) => route.path === pathname).map((route) => route.method) }
export function normalizeStagingScenario(value) {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return STAGING_SCENARIOS.includes(normalized) ? normalized : null
}
export function isStaticAssetPath(pathname) {
  return pathname === '/' || pathname === '/favicon.ico' || pathname.startsWith('/_next/')
}
export function sensitiveResponseHeaders(extra = {}) {
  return new Headers({
    'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache', Expires: '0',
    'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'X-Stracker-Gateway': GATEWAY_MARKER, ...extra,
  })
}
