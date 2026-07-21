export const GATEWAY_MARKER = 'private-poc-v1'
export const MAX_REQUEST_BYTES = 512 * 1024
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

const routeList = [
  { method: 'GET', path: '/api/session/status', upstreamPath: '/api/session/status', body: 'none' },
  { method: 'POST', path: '/api/session/import', upstreamPath: '/api/session/import', body: 'json' },
  { method: 'POST', path: '/api/session/delete', upstreamPath: '/api/session/delete', body: 'none' },
  { method: 'GET', path: '/points', upstreamPath: '/points', body: 'none' },
]

export const ROUTES = Object.freeze(routeList)

export function findRoute(method, pathname) {
  return ROUTES.find((route) => route.method === method && route.path === pathname) || null
}

export function allowedMethods(pathname) {
  return ROUTES.filter((route) => route.path === pathname).map((route) => route.method)
}

export function sensitiveResponseHeaders(extra = {}) {
  return new Headers({
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Stracker-Gateway': GATEWAY_MARKER,
    ...extra,
  })
}
