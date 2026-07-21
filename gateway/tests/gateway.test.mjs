import assert from 'node:assert/strict'
import test from 'node:test'
import { clearAccessJwksCache } from '../src/access-jwt.mjs'
import { createGateway } from '../src/index.mjs'
import { createAccessFixture, createMockBackend, gatewayEnv } from './helpers.mjs'

async function authorizedRequest(path, init = {}) {
  clearAccessJwksCache()
  const fixture = await createAccessFixture()
  const token = await fixture.sign()
  const backend = createMockBackend(init.backendOptions)
  const gateway = createGateway({ jwksFetch: fixture.jwksFetch })
  const headers = new Headers(init.headers)
  headers.set('Cf-Access-Jwt-Assertion', token)
  const request = new Request(`https://gateway.example${path}`, { method: init.method || 'GET', headers, body: init.body })
  const response = await gateway.fetch(request, gatewayEnv(backend.binding))
  return { response, backend }
}

test('fails closed without Cloudflare Access and without complete bindings', async () => {
  const backend = createMockBackend()
  const gateway = createGateway({ jwksFetch: async () => { throw new Error('must not fetch') } })
  const missingAccess = await gateway.fetch(new Request('https://gateway.example/api/session/status'), gatewayEnv(backend.binding))
  assert.equal(missingAccess.status, 403)
  assert.equal(backend.calls.length, 0)
  assert.match(missingAccess.headers.get('cache-control'), /no-store/)

  const missingToken = await gateway.fetch(
    new Request('https://gateway.example/api/session/status'),
    { ...gatewayEnv(backend.binding), STRACKER_SERVICE_TOKEN: '' },
  )
  assert.equal(missingToken.status, 503)
  assert.equal(backend.calls.length, 0)
})

test('allows only explicit method and path pairs', async () => {
  for (const candidate of [
    { path: '/admin', method: 'GET', status: 404 },
    { path: '/api/session/status', method: 'POST', status: 405 },
    { path: '/points?url=https://evil.invalid', method: 'GET', status: 400 },
    { path: '/https://evil.invalid/', method: 'GET', status: 404 },
  ]) {
    const { response, backend } = await authorizedRequest(candidate.path, { method: candidate.method })
    assert.equal(response.status, candidate.status)
    assert.equal(backend.calls.length, 0)
  }
})

test('reconstructs upstream headers and overwrites client spoofing', async () => {
  const { response, backend } = await authorizedRequest('/api/session/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer attacker',
      Cookie: 'CF_Authorization=attacker',
      'X-Stracker-Service-Token': 'attacker-token',
      'X-Forwarded-Host': 'evil.invalid',
      'X-Client-Secret': 'attacker-secret',
    },
    body: JSON.stringify({ raw: 'MOCK_SESSION_ONLY' }),
  })
  assert.equal(response.status, 200)
  assert.equal(backend.calls.length, 1)
  assert.equal(response.headers.get('x-stracker-gateway'), 'private-poc-v1')
  assert.match(response.headers.get('cache-control'), /no-store/)
})

test('does not forward sensitive upstream response headers', async () => {
  const { response } = await authorizedRequest('/points', {
    backendOptions: {
      handler: async () => new Response(JSON.stringify({ points: [] }), {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'secret=leak',
          Location: 'https://evil.invalid',
          'Cache-Control': 'public, max-age=3600',
        },
      }),
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(response.headers.get('location'), null)
  assert.match(response.headers.get('cache-control'), /no-store/)
})

test('rejects non-JSON upstream content', async () => {
  const { response } = await authorizedRequest('/points', {
    backendOptions: { handler: async () => new Response('<html>no</html>', { headers: { 'Content-Type': 'text/html' } }) },
  })
  assert.equal(response.status, 502)
  assert.equal((await response.json()).error, 'UPSTREAM_CONTENT_TYPE_REJECTED')
})
