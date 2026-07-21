import assert from 'node:assert/strict'

export const TEAM_DOMAIN = 'https://stracker-poc.cloudflareaccess.com'
export const ACCESS_AUD = 'stracker-poc-audience'
export const SERVICE_TOKEN = 'MOCK_SERVICE_TOKEN_TEST_ONLY'

function base64UrlBytes(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlJson(value) {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)))
}

export async function createAccessFixture() {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  Object.assign(publicJwk, { kid: 'test-key-1', alg: 'RS256', use: 'sig' })

  async function sign(overrides = {}, headerOverrides = {}) {
    const now = Math.floor(Date.now() / 1000)
    const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key-1', ...headerOverrides }
    const payload = {
      iss: TEAM_DOMAIN,
      aud: ACCESS_AUD,
      sub: 'mock-user',
      email: 'authorized@example.invalid',
      iat: now - 5,
      nbf: now - 5,
      exp: now + 300,
      ...overrides,
    }
    const encodedHeader = base64UrlJson(header)
    const encodedPayload = base64UrlJson(payload)
    const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
    const signature = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      keyPair.privateKey,
      signingInput,
    )
    return `${encodedHeader}.${encodedPayload}.${base64UrlBytes(new Uint8Array(signature))}`
  }

  const jwksFetch = async (input) => {
    assert.equal(String(input), `${TEAM_DOMAIN}/cdn-cgi/access/certs`)
    return Response.json({ keys: [publicJwk] }, { headers: { 'Cache-Control': 'no-store' } })
  }

  return { sign, jwksFetch, publicJwk }
}

export function createMockBackend(options = {}) {
  const calls = []
  const binding = {
    async fetch(request) {
      calls.push(request)
      assert.equal(new URL(request.url).origin, 'https://stracker-backend.internal')
      assert.equal(request.headers.get('x-stracker-service-token'), SERVICE_TOKEN)
      assert.equal(request.headers.get('authorization'), null)
      assert.equal(request.headers.get('cookie'), null)
      assert.equal(request.headers.get('cf-access-jwt-assertion'), null)
      assert.equal(request.headers.get('x-forwarded-host'), null)
      assert.equal(request.headers.get('x-client-secret'), null)

      if (options.handler) return options.handler(request)
      const path = new URL(request.url).pathname
      if (path === '/api/session/status') {
        return Response.json({ appAuthenticated: true, configured: false, state: 'SHARED_UNCONFIGURED', health: 'UNCONFIGURED', count: 0, criticalPresent: [], criticalMissing: [], message: 'mock' })
      }
      if (path === '/api/session/import') {
        const payload = await request.json()
        assert.equal(payload.raw, 'MOCK_SESSION_ONLY')
        return Response.json({ status: 'ok', action: 'import', appAuthenticated: true, configured: true, state: 'SHARED_NO_LOCATION', health: 'NO_LOCATION_SHARED', formatDetected: 'mock', count: 1, criticalPresent: [], criticalMissing: [], message: 'mock imported' })
      }
      if (path === '/points') {
        return Response.json({ points: [], ghostrail_pts: [], last_update: null, state: { mock: true } })
      }
      if (path === '/api/session/delete') {
        return Response.json({ status: 'ok' })
      }
      return Response.json({ error: 'unexpected' }, { status: 500 })
    },
  }
  return { binding, calls }
}

export function gatewayEnv(binding) {
  return {
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD,
    STRACKER_SERVICE_TOKEN: SERVICE_TOKEN,
    STRACKER_BACKEND: binding,
  }
}
