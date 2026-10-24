import assert from 'node:assert/strict'
import test from 'node:test'
import backend from '../src/index.mjs'

const TOKEN = 'SYNTHETIC_TEST_TOKEN_0123456789'

function internalRequest(path, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  headers.set('X-Stracker-Service-Token', TOKEN)
  headers.set('X-Stracker-Gateway-Version', 'private-poc-v1')
  return new Request(`https://stracker-backend.internal${path}`, { ...init, headers })
}

const env = { STRACKER_SERVICE_TOKEN: TOKEN }

test('mock backend has no useful response without the staging service token', async () => {
  const response = await backend.fetch(new Request('https://stracker-backend.internal/points'), env)
  assert.equal(response.status, 403)
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0')
})

test('default status is synthetic and unconfigured', async () => {
  const response = await backend.fetch(internalRequest('/api/session/status'), env)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.synthetic, true)
  assert.equal(body.dataset, 'STRACKER_STAGING_SYNTHETIC_V1')
  assert.equal(body.state, 'SHARED_UNCONFIGURED')
  assert.equal(body.securityProof.publicIngress, false)
})

test('real session material is rejected', async () => {
  const response = await backend.fetch(internalRequest('/api/session/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: 'SID=real-looking-value' }),
  }), env)
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'REAL_SESSION_REJECTED')
})

test('synthetic session marker is accepted without persistence', async () => {
  const response = await backend.fetch(internalRequest('/api/session/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: 'MOCK_SESSION_ONLY' }),
  }), env)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.synthetic, true)
  assert.equal(body.state, 'SHARED_READY')
})

test('controlled location states use only Null Island synthetic data', async () => {
  for (const scenario of ['location_fresh', 'location_stale']) {
    const response = await backend.fetch(internalRequest('/points', {
      headers: { 'X-Stracker-Internal-Scenario': scenario },
    }), env)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.points[0].lat, 0)
    assert.equal(body.points[0].lng, 0)
    assert.equal(body.points[0].label, 'SYNTHETIC_NULL_ISLAND_NOT_REAL')
  }
})

test('client-sensitive headers are rejected at the internal boundary', async () => {
  const response = await backend.fetch(internalRequest('/points', {
    headers: { Authorization: 'Bearer must-not-arrive' },
  }), env)
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'CLIENT_HEADER_LEAK')
})

test('unknown paths, methods and query strings fail closed', async () => {
  assert.equal((await backend.fetch(internalRequest('/unknown'), env)).status, 404)
  assert.equal((await backend.fetch(internalRequest('/points', { method: 'POST' }), env)).status, 405)
  assert.equal((await backend.fetch(internalRequest('/points?target=https://example.com'), env)).status, 400)
})
