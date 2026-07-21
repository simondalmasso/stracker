import { AccessJwtError, validateAccessJwt } from './access-jwt.mjs'
import {
  GATEWAY_MARKER,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  allowedMethods,
  findRoute,
  isStaticAssetPath,
  normalizeStagingScenario,
  sensitiveResponseHeaders,
} from './policy.mjs'

const INTERNAL_BACKEND_ORIGIN = 'https://stracker-backend.internal'

function jsonResponse(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), { status, headers: sensitiveResponseHeaders(extraHeaders) })
}

function fail(status, code, message, extraHeaders = {}) {
  return jsonResponse(status, { status: 'error', error: code, message }, extraHeaders)
}

function requiredBinding(value) {
  return typeof value === 'string' && value.trim() ? value : null
}

async function readRequestBody(request, bodyPolicy) {
  const contentLength = Number(request.headers.get('content-length') || '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw Object.assign(new Error('Request body is too large.'), { status: 413, code: 'REQUEST_TOO_LARGE' })
  }
  if (bodyPolicy === 'none') {
    if (contentLength > 0) throw Object.assign(new Error('This route does not accept a request body.'), { status: 400, code: 'BODY_NOT_ALLOWED' })
    return undefined
  }
  const contentType = request.headers.get('content-type') || ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('Content-Type must be application/json.'), { status: 415, code: 'CONTENT_TYPE_REJECTED' })
  }
  const body = await request.arrayBuffer()
  if (body.byteLength > MAX_REQUEST_BYTES) throw Object.assign(new Error('Request body is too large.'), { status: 413, code: 'REQUEST_TOO_LARGE' })
  if (!body.byteLength) throw Object.assign(new Error('JSON body is required.'), { status: 400, code: 'BODY_REQUIRED' })
  try { JSON.parse(new TextDecoder().decode(body)) } catch { throw Object.assign(new Error('Request body must contain valid JSON.'), { status: 400, code: 'INVALID_JSON' }) }
  return body
}

function requestedScenario(request) {
  const raw = request.headers.get('x-stracker-staging-scenario')
  if (!raw) return null
  const normalized = normalizeStagingScenario(raw)
  if (!normalized) throw Object.assign(new Error('Staging scenario is not allowed.'), { status: 400, code: 'SCENARIO_NOT_ALLOWED' })
  return normalized
}

function buildUpstreamHeaders(route, serviceToken, scenario) {
  const headers = new Headers({
    Accept: 'application/json',
    'X-Stracker-Service-Token': serviceToken,
    'X-Stracker-Gateway-Version': GATEWAY_MARKER,
  })
  if (route.body === 'json') headers.set('Content-Type', 'application/json')
  if (scenario) headers.set('X-Stracker-Internal-Scenario', scenario)
  return headers
}

async function sanitizeUpstreamResponse(response) {
  if (response.status >= 300 && response.status < 400) return fail(502, 'UPSTREAM_REDIRECT_REJECTED', 'Protected backend redirect was rejected.')
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('application/json')) return fail(502, 'UPSTREAM_CONTENT_TYPE_REJECTED', 'Protected backend returned an unsupported response.')
  const body = await response.arrayBuffer()
  if (body.byteLength > MAX_RESPONSE_BYTES) return fail(502, 'UPSTREAM_RESPONSE_TOO_LARGE', 'Protected backend response exceeded the gateway limit.')
  return new Response(body, { status: response.status, headers: sensitiveResponseHeaders() })
}

function securedAssetHeaders(sourceHeaders, pathname) {
  const headers = new Headers()
  const contentType = sourceHeaders.get('content-type')
  if (contentType) headers.set('Content-Type', contentType)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()')
  headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
  headers.set('X-Stracker-Gateway', GATEWAY_MARKER)
  headers.set('X-Stracker-Access-Subject', 'verified')
  if (pathname === '/') {
    headers.set('Cache-Control', 'no-store, max-age=0')
    headers.set('Pragma', 'no-cache')
  } else {
    const cacheControl = sourceHeaders.get('cache-control')
    headers.set('Cache-Control', cacheControl || 'public, max-age=31536000, immutable')
  }
  return headers
}

async function serveAsset(request, env, pathname) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return fail(503, 'ASSETS_NOT_CONFIGURED', 'Static assets binding is unavailable.')
  const response = await env.ASSETS.fetch(request)
  if (response.status >= 300 && response.status < 400) return fail(502, 'ASSET_REDIRECT_REJECTED', 'Static asset redirect was rejected.')
  if (!response.ok) return fail(response.status === 404 ? 404 : 502, response.status === 404 ? 'ASSET_NOT_FOUND' : 'ASSET_UNAVAILABLE', response.status === 404 ? 'Static asset was not found.' : 'Static asset is unavailable.')
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    headers: securedAssetHeaders(response.headers, pathname),
  })
}

export function createGateway(dependencies = {}) {
  const validateJwt = dependencies.validateJwt || validateAccessJwt
  const jwksFetch = dependencies.jwksFetch || fetch
  return {
    async fetch(request, env) {
      if (!env || !env.STRACKER_BACKEND || typeof env.STRACKER_BACKEND.fetch !== 'function') return fail(503, 'GATEWAY_NOT_CONFIGURED', 'Private gateway backend binding is unavailable.')
      const teamDomain = requiredBinding(env.ACCESS_TEAM_DOMAIN)
      const audience = requiredBinding(env.ACCESS_AUD)
      const serviceToken = requiredBinding(env.STRACKER_SERVICE_TOKEN)
      if (!teamDomain || !audience || !serviceToken) return fail(503, 'GATEWAY_NOT_CONFIGURED', 'Private gateway bindings are incomplete.')

      const assertion = request.headers.get('cf-access-jwt-assertion')
      let accessClaims
      try {
        accessClaims = await validateJwt(assertion, { teamDomain, audience, fetchImpl: jwksFetch })
      } catch (error) {
        const code = error instanceof AccessJwtError ? error.code : 'ACCESS_JWT_INVALID'
        return fail(403, code, 'Cloudflare Access authorization is required.')
      }

      const url = new URL(request.url)
      if (url.search || url.hash) return fail(400, 'QUERY_NOT_ALLOWED', 'Query parameters are not accepted by this gateway.')

      const method = request.method.toUpperCase()
      if ((method === 'GET' || method === 'HEAD') && isStaticAssetPath(url.pathname)) return serveAsset(request, env, url.pathname)

      const route = findRoute(method, url.pathname)
      if (!route) {
        const methods = allowedMethods(url.pathname)
        if (methods.length) return fail(405, 'METHOD_NOT_ALLOWED', 'Method is not allowed for this route.', { Allow: methods.join(', ') })
        return fail(404, 'ROUTE_NOT_ALLOWED', 'Route is not exposed by this gateway.')
      }

      let body
      let scenario
      try {
        body = await readRequestBody(request, route.body)
        scenario = requestedScenario(request)
      } catch (error) {
        return fail(error.status || 400, error.code || 'INVALID_REQUEST', error.message || 'Invalid request.')
      }

      const upstreamRequest = new Request(new URL(route.upstreamPath, INTERNAL_BACKEND_ORIGIN), {
        method: route.method,
        headers: buildUpstreamHeaders(route, serviceToken, scenario),
        body,
        redirect: 'error',
      })

      let upstreamResponse
      try { upstreamResponse = await env.STRACKER_BACKEND.fetch(upstreamRequest) } catch { return fail(502, 'UPSTREAM_UNAVAILABLE', 'Protected backend is unavailable.') }
      const response = await sanitizeUpstreamResponse(upstreamResponse)
      response.headers.set('X-Stracker-Access-Subject', typeof accessClaims.sub === 'string' ? 'verified' : 'verified-anonymous')
      return response
    },
  }
}

export default createGateway()
