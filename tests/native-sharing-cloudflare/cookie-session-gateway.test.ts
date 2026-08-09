import '../cookie-session/cookie-session.test'
import { afterEach, describe, expect, test } from 'bun:test'
import { handlePublicRuntimeRequest } from '../../native-sharing-cloudflare/src/public-worker'
import { handleNativeSharingRequest } from '../../native-sharing-cloudflare/src/worker'
import { TestNativeSharingNamespace, testBindings } from './test-runtime'

const ORIGIN = 'https://stracker.example'
const SESSION = 's'.repeat(43)
const namespaces: TestNativeSharingNamespace[] = []
const fixture = JSON.stringify([
  { name: 'SID', value: 'synthetic-one', domain: '.google.com' },
  { name: 'SAPISID', value: 'synthetic-two', domain: '.google.com' },
])

afterEach(() => {
  while (namespaces.length) namespaces.pop()?.close()
})

function fakeEnv(calls: Array<{ method: string; path: string }>) {
  return {
    NATIVE_SHARING_BACKEND: {
      async fetch(request: Request) {
        const url = new URL(request.url)
        calls.push({ method: request.method, path: url.pathname })
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        })
      },
    },
  }
}

function request(path: string, method: string, headers: HeadersInit = {}, body = '{}') {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
    body: method === 'POST' ? body : undefined,
  })
}

describe('public cookie-session gateway', () => {
  test('forwards only the exact method and path allowlist', async () => {
    const calls: Array<{ method: string; path: string }> = []
    expect((await handlePublicRuntimeRequest(request('/api/cookie-sessions', 'POST'), fakeEnv(calls))).status).toBe(200)
    expect((await handlePublicRuntimeRequest(request(`/api/cookie-sessions/${SESSION}/status`, 'GET'), fakeEnv(calls))).status).toBe(200)
    expect((await handlePublicRuntimeRequest(request(`/api/cookie-sessions/${SESSION}/point`, 'GET'), fakeEnv(calls))).status).toBe(200)
    expect((await handlePublicRuntimeRequest(request(`/api/cookie-sessions/${SESSION}/refresh`, 'POST'), fakeEnv(calls))).status).toBe(200)
    expect((await handlePublicRuntimeRequest(request(`/api/cookie-sessions/${SESSION}`, 'DELETE'), fakeEnv(calls))).status).toBe(200)
    expect(calls.length).toBe(5)
  })

  test('rejects query strings, cross-origin calls and unsupported methods before the backend', async () => {
    const calls: Array<{ method: string; path: string }> = []
    expect((await handlePublicRuntimeRequest(request('/api/cookie-sessions?x=1', 'POST'), fakeEnv(calls))).status).toBe(400)
    expect((await handlePublicRuntimeRequest(new Request(`${ORIGIN}/api/cookie-sessions`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' }), fakeEnv(calls))).status).toBe(403)
    expect((await handlePublicRuntimeRequest(request('/api/cookie-sessions', 'GET'), fakeEnv(calls))).status).toBe(405)
    expect((await handlePublicRuntimeRequest(request('/api/cookie-sessions/not-valid/status', 'GET'), fakeEnv(calls))).status).toBe(404)
    expect(calls.length).toBe(0)
  })

  test('drops expired ancillary cookies at the exact public worker boundary', async () => {
    let downstreamRaw = ''
    const publicEnv = {
      NATIVE_SHARING_BACKEND: {
        async fetch(downstream: Request) {
          const body = await downstream.json() as { raw: string }
          downstreamRaw = body.raw
          return new Response(JSON.stringify({
            status: 'ok', sessionId: SESSION, ownerToken: 'o'.repeat(43), storagePolicy: 'memory-only',
            state: 'no_location', policyVersion: 'google-maps-cookie-minimum-v1', format: 'COOKIE_EDITOR_JSON',
            cookieCount: 1, expiresAt: new Date(Date.now() + 60_000).toISOString(), validatedAt: new Date().toISOString(), locationAvailable: false,
          }), { status: 201, headers: { 'Content-Type': 'application/json' } })
        },
      },
    }
    const stale = JSON.stringify([
      { name: 'SID', value: 'current-auth', domain: '.google.com' },
      { name: 'NID', value: 'expired-auxiliary', domain: '.google.com', expirationDate: 1 },
    ])
    const response = await handlePublicRuntimeRequest(request('/api/cookie-sessions', 'POST', {}, JSON.stringify({ raw: stale, durationMs: 60_000 })), publicEnv)
    expect(response.status).toBe(201)
    const body = await response.json() as Record<string, unknown>
    expect(body.policyVersion).toBe('google-maps-cookie-minimum-v2')
    expect(body.totalParsed).toBe(2)
    expect(body.expiredDropped).toBe(1)
    expect(body.retainedCount).toBe(1)
    expect(downstreamRaw).toContain('current-auth')
    expect(downstreamRaw).not.toContain('expired-auxiliary')
    expect(JSON.stringify(body)).not.toContain('current-auth')
    expect(JSON.stringify(body)).not.toContain('expired-auxiliary')
  })

  test('imports only after backend confirmation, returns metadata-only status and deletes the server copy', async () => {
    const namespace = new TestNativeSharingNamespace()
    namespaces.push(namespace)
    const privateEnv = testBindings(namespace)
    const publicEnv = {
      NATIVE_SHARING_BACKEND: {
        fetch: (downstream: Request) => handleNativeSharingRequest(downstream, privateEnv),
      },
    }
    const importedResponse = await handlePublicRuntimeRequest(request('/api/cookie-sessions', 'POST', {}, JSON.stringify({ raw: fixture, durationMs: 30 * 60_000 })), publicEnv)
    expect(importedResponse.status).toBe(201)
    const imported = await importedResponse.json() as { sessionId: string; ownerToken: string; storagePolicy: string; cookieCount: number; totalParsed: number; expiredDropped: number; retainedCount: number; locationAvailable: boolean }
    expect(imported.storagePolicy).toBe('memory-only')
    expect(imported.cookieCount).toBe(2)
    expect(imported.totalParsed).toBe(2)
    expect(imported.expiredDropped).toBe(0)
    expect(imported.retainedCount).toBe(2)
    expect(imported.locationAvailable).toBe(false)
    expect(JSON.stringify(imported)).not.toContain('synthetic-one')

    const owner = { 'X-Stracker-Cookie-Owner': imported.ownerToken }
    const statusResponse = await handlePublicRuntimeRequest(request(`/api/cookie-sessions/${imported.sessionId}/status`, 'GET', owner), publicEnv)
    expect(statusResponse.status).toBe(200)
    const status = await statusResponse.json()
    expect(JSON.stringify(status)).not.toContain('point')
    expect(JSON.stringify(status)).not.toContain('synthetic-two')

    const pointResponse = await handlePublicRuntimeRequest(request(`/api/cookie-sessions/${imported.sessionId}/point`, 'GET', owner), publicEnv)
    expect(pointResponse.status).toBe(200)
    expect(await pointResponse.json()).toMatchObject({ state: 'no_location', point: null })

    expect((await handlePublicRuntimeRequest(request(`/api/cookie-sessions/${imported.sessionId}`, 'DELETE', owner), publicEnv)).status).toBe(200)
    expect((await handlePublicRuntimeRequest(request(`/api/cookie-sessions/${imported.sessionId}/status`, 'GET', owner), publicEnv)).status).toBe(404)
  })
})
