import assert from 'node:assert/strict'
import test from 'node:test'
import { clearAccessJwksCache } from '../src/access-jwt.mjs'
import { createGateway } from '../src/index.mjs'
import { createAccessFixture, createMockBackend, gatewayEnv } from './helpers.mjs'

test('mock shared-location E2E traverses Access, gateway and protected backend', async () => {
  clearAccessJwksCache()
  const fixture = await createAccessFixture()
  const token = await fixture.sign()
  const backend = createMockBackend()
  const gateway = createGateway({ jwksFetch: fixture.jwksFetch })
  const env = gatewayEnv(backend.binding)

  const call = async (path, init = {}) => {
    const headers = new Headers(init.headers)
    headers.set('Cf-Access-Jwt-Assertion', token)
    const response = await gateway.fetch(new Request(`https://gateway.example${path}`, { ...init, headers }), env)
    assert.equal(response.headers.get('x-stracker-gateway'), 'private-poc-v1')
    assert.match(response.headers.get('cache-control'), /no-store/)
    return response
  }

  assert.equal((await call('/api/session/status')).status, 200)
  assert.equal((await call('/api/session/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: 'MOCK_SESSION_ONLY' }),
  })).status, 200)
  assert.equal((await call('/points')).status, 200)
  assert.equal((await call('/api/session/delete', { method: 'POST' })).status, 200)
  assert.equal(backend.calls.length, 4)
})
