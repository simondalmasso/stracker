import assert from 'node:assert/strict'
import test from 'node:test'
import { createGateway } from '../src/index.mjs'
import backend from '../mock-backend/src/index.mjs'

const TOKEN = 'SYNTHETIC_TEST_TOKEN_0123456789'
const env = {
  ACCESS_TEAM_DOMAIN: 'https://stracker-test.cloudflareaccess.com',
  ACCESS_AUD: 'test-aud',
  STRACKER_SERVICE_TOKEN: TOKEN,
  STRACKER_BACKEND: { fetch: (request) => backend.fetch(request, { STRACKER_SERVICE_TOKEN: TOKEN }) },
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/') return new Response('<!doctype html><title>STRACKER STAGING SINTETICO</title>', { headers: { 'Content-Type': 'text/html' } })
      if (path === '/_next/static/test.js') return new Response('console.log("synthetic")', { headers: { 'Content-Type': 'application/javascript' } })
      return new Response('missing', { status: 404 })
    },
  },
}
const gateway = createGateway({ validateJwt: async () => ({ sub: 'synthetic-operator' }) })

function request(path, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('Cf-Access-Jwt-Assertion', 'synthetic-valid-assertion')
  return new Request(`https://stracker-gateway-staging.example${path}`, { ...init, headers })
}

test('Access validation wraps static assets and root is no-store', async () => {
  const root = await gateway.fetch(request('/'), env)
  assert.equal(root.status, 200)
  assert.equal(root.headers.get('x-stracker-gateway'), 'private-poc-v1')
  assert.equal(root.headers.get('cache-control'), 'no-store, max-age=0')
  assert.match(await root.text(), /STAGING SINTETICO/)

  const asset = await gateway.fetch(request('/_next/static/test.js'), env)
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('x-stracker-access-subject'), 'verified')
})

test('live service-binding contract strips client headers and injects synthetic token', async () => {
  const response = await gateway.fetch(request('/api/session/status', {
    headers: {
      Authorization: 'Bearer client-value',
      Cookie: 'SID=client-value',
      'X-Stracker-Service-Token': 'client-value',
      'X-Forwarded-Host': 'attacker.example',
    },
  }), env)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.synthetic, true)
  assert.equal(body.securityProof.serviceTokenReceived, true)
  assert.equal(body.securityProof.authorizationReceived, false)
  assert.equal(body.securityProof.cookieReceived, false)
  assert.equal(body.securityProof.accessJwtReceived, false)
  assert.equal(body.securityProof.forwardingHeadersReceived, false)
})

test('shared synthetic import reaches the internal Worker only', async () => {
  const response = await gateway.fetch(request('/api/session/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: 'MOCK_SESSION_ONLY' }),
  }), env)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.synthetic, true)
  assert.equal(body.state, 'SHARED_READY')
})

test('missing Access, missing binding and disabled backend fail closed', async () => {
  const accessGateway = createGateway({ validateJwt: async () => { throw new Error('blocked') } })
  assert.equal((await accessGateway.fetch(new Request('https://example.test/'), env)).status, 403)
  assert.equal((await gateway.fetch(request('/points'), { ...env, STRACKER_BACKEND: null })).status, 503)
  const unavailable = { ...env, STRACKER_BACKEND: { fetch: async () => { throw new Error('offline') } } }
  assert.equal((await gateway.fetch(request('/points'), unavailable)).status, 502)
})

test('open proxy, SSRF, unknown routes, methods and query strings are blocked', async () => {
  assert.equal((await gateway.fetch(request('/https://example.com'), env)).status, 404)
  assert.equal((await gateway.fetch(request('/points?url=https://169.254.169.254'), env)).status, 400)
  assert.equal((await gateway.fetch(request('/points', { method: 'POST' }), env)).status, 405)
  assert.equal((await gateway.fetch(request('/unknown'), env)).status, 404)
})

test('unapproved staging scenarios are rejected', async () => {
  const response = await gateway.fetch(request('/points', { headers: { 'X-Stracker-Staging-Scenario': 'real-person' } }), env)
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'SCENARIO_NOT_ALLOWED')
})
