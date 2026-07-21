const DATASET = 'STRACKER_STAGING_SYNTHETIC_V1'
const GATEWAY_MARKER = 'private-poc-v1'
const ALLOWED_SCENARIOS = new Set([
  'session_valid', 'session_absent', 'session_expired',
  'location_fresh', 'location_stale', 'no_location', 'timeout', 'upstream_error', 'redirect', 'set_cookie',
])

function headers() {
  return new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache', Expires: '0',
    'X-Content-Type-Options': 'nosniff',
    'X-Stracker-Mock-Backend': 'internal-service-binding-v1',
  })
}

function json(status, payload) { return new Response(JSON.stringify({ synthetic: true, dataset: DATASET, ...payload }), { status, headers: headers() }) }
function fail(status, error, message) { return json(status, { status: 'error', error, message }) }

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = new TextEncoder().encode(left)
  const b = new TextEncoder().encode(right)
  let mismatch = a.length ^ b.length
  const max = Math.max(a.length, b.length)
  for (let index = 0; index < max; index += 1) mismatch |= (a[index % Math.max(a.length, 1)] || 0) ^ (b[index % Math.max(b.length, 1)] || 0)
  return mismatch === 0
}

function sensitiveClientHeaderPresent(request) {
  const names = ['authorization', 'cookie', 'cf-access-jwt-assertion', 'x-forwarded-for', 'x-forwarded-host', 'forwarded', 'cf-connecting-ip']
  return names.some((name) => request.headers.has(name))
}

function securityProof() {
  return {
    serviceBinding: 'live-internal-only',
    serviceTokenReceived: true,
    authorizationReceived: false,
    cookieReceived: false,
    accessJwtReceived: false,
    forwardingHeadersReceived: false,
    publicIngress: false,
  }
}

function statusPayload(scenario) {
  if (scenario === 'session_absent') return { appAuthenticated: true, configured: false, state: 'SHARED_UNCONFIGURED', health: 'UNCONFIGURED', formatDetected: 'synthetic', count: 0, criticalPresent: [], criticalMissing: [], message: 'Synthetic staging session is absent.', securityProof: securityProof() }
  if (scenario === 'session_expired') return { appAuthenticated: true, configured: true, state: 'SHARED_EXPIRED', health: 'EXPIRED', formatDetected: 'synthetic', count: 1, criticalPresent: ['SYNTHETIC_ONLY'], criticalMissing: [], message: 'Synthetic staging session is expired.', securityProof: securityProof() }
  return { appAuthenticated: true, configured: true, state: 'SHARED_READY', health: 'VALID', formatDetected: 'synthetic', count: 1, criticalPresent: ['SYNTHETIC_ONLY'], criticalMissing: [], message: 'Synthetic staging session is valid.', securityProof: securityProof() }
}

function point(capturedAt, freshness) {
  return { lat: 0, lng: 0, accuracy: 999999, timestamp: capturedAt, freshness, label: 'SYNTHETIC_NULL_ISLAND_NOT_REAL', synthetic: true }
}

function pointsPayload(scenario) {
  if (scenario === 'no_location') return { points: [], ghostrail_pts: [], last_update: null, state: { scenario, label: 'SYNTHETIC_NO_LOCATION', securityProof: securityProof() } }
  const now = Date.now()
  const capturedAt = new Date(scenario === 'location_stale' ? now - 10 * 60 * 1000 : now).toISOString()
  const latest = point(capturedAt, scenario === 'location_stale' ? 'stale' : 'fresh')
  return { points: [latest], ghostrail_pts: [latest], last_update: capturedAt, state: { scenario, label: 'SYNTHETIC_ONLY', securityProof: securityProof() } }
}

export default {
  async fetch(request, env) {
    const expectedToken = typeof env?.STRACKER_SERVICE_TOKEN === 'string' ? env.STRACKER_SERVICE_TOKEN : ''
    if (!expectedToken) return fail(503, 'MOCK_NOT_CONFIGURED', 'Synthetic backend secret is unavailable.')
    if (!constantTimeEqual(request.headers.get('x-stracker-service-token') || '', expectedToken)) return fail(403, 'SERVICE_TOKEN_INVALID', 'Synthetic service token is invalid.')
    if (request.headers.get('x-stracker-gateway-version') !== GATEWAY_MARKER) return fail(403, 'GATEWAY_ATTESTATION_INVALID', 'Gateway attestation is invalid.')
    if (sensitiveClientHeaderPresent(request)) return fail(400, 'CLIENT_HEADER_LEAK', 'Client-sensitive headers reached the internal backend.')

    const url = new URL(request.url)
    if (url.origin !== 'https://stracker-backend.internal' || url.search || url.hash) return fail(400, 'INTERNAL_ROUTE_INVALID', 'Internal backend request is invalid.')
    const scenario = (request.headers.get('x-stracker-internal-scenario') || '').trim().toLowerCase()
    if (scenario && !ALLOWED_SCENARIOS.has(scenario)) return fail(400, 'SCENARIO_NOT_ALLOWED', 'Synthetic scenario is not allowed.')

    if (request.method === 'GET' && url.pathname === '/api/session/status') return json(200, statusPayload(scenario || 'session_absent'))
    if (request.method === 'POST' && url.pathname === '/api/session/import') {
      const payload = await request.json().catch(() => null)
      if (!payload || payload.raw !== 'MOCK_SESSION_ONLY') return fail(400, 'REAL_SESSION_REJECTED', 'Only the synthetic staging marker is accepted.')
      return json(200, { status: 'ok', action: 'import', ...statusPayload('session_valid'), message: 'Synthetic staging session activated.' })
    }
    if (request.method === 'POST' && url.pathname === '/api/session/delete') return json(200, { status: 'ok', action: 'delete', message: 'Synthetic staging session cleared.', securityProof: securityProof() })
    if (request.method === 'GET' && url.pathname === '/points') {
      if (scenario === 'timeout') return fail(504, 'SYNTHETIC_TIMEOUT', 'Synthetic staging timeout.')
      if (scenario === 'upstream_error') return fail(502, 'SYNTHETIC_UPSTREAM_ERROR', 'Synthetic staging upstream error.')
      if (scenario === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://example.invalid/blocked' } })
      if (scenario === 'set_cookie') {
        const responseHeaders = headers()
        responseHeaders.set('Set-Cookie', 'SYNTHETIC_COOKIE_MUST_BE_STRIPPED=1; Secure; HttpOnly')
        return new Response(JSON.stringify({ synthetic: true, dataset: DATASET, ...pointsPayload('location_fresh') }), { status: 200, headers: responseHeaders })
      }
      return json(200, pointsPayload(scenario || 'location_fresh'))
    }
    const allowedPath = ['/api/session/status', '/api/session/import', '/api/session/delete', '/points'].includes(url.pathname)
    return fail(allowedPath ? 405 : 404, allowedPath ? 'METHOD_NOT_ALLOWED' : 'ROUTE_NOT_ALLOWED', allowedPath ? 'Method is not allowed.' : 'Route is not allowed.')
  },
}
