import { afterEach, describe, expect, test } from 'bun:test'
import type { CreateSessionResponse, ViewerExchangeResponse } from '../../native-sharing/src/contracts.js'
import { handleMinimumRuntimeRequest } from '../../native-sharing-cloudflare/src/minimal-worker.js'
import { handleNativeSharingRequest } from '../../native-sharing-cloudflare/src/worker.js'
import { TestNativeSharingNamespace, testBindings } from './test-runtime.js'

const ORIGIN = 'https://stracker.test'
const namespaces: TestNativeSharingNamespace[] = []

afterEach(() => {
  while (namespaces.length) namespaces.pop()?.close()
})

function publicRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  headers.set('Origin', ORIGIN)
  return new Request(`${ORIGIN}${path}`, { ...init, headers })
}

function gateway() {
  const namespace = new TestNativeSharingNamespace()
  namespaces.push(namespace)
  const backendEnv = testBindings(namespace)
  const forwarded: Array<{ method: string; pathname: string; search: string }> = []
  return {
    namespace,
    forwarded,
    env: {
      NATIVE_SHARING_BACKEND: {
        async fetch(request: Request): Promise<Response> {
          const url = new URL(request.url)
          forwarded.push({ method: request.method, pathname: url.pathname, search: url.search })
          return handleNativeSharingRequest(request, backendEnv)
        },
      },
      ASSETS: {
        fetch(request: Request): Promise<Response> {
          return Promise.resolve(new Response(`asset:${new URL(request.url).pathname}`, { status: 200 }))
        },
      },
      CF_VERSION_METADATA: {
        id: '11111111-2222-4333-8444-555555555555',
        tag: `same-domain-${'a'.repeat(40)}`,
        timestamp: '2026-08-01T00:00:00.000Z',
      },
    },
  }
}

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>
}

describe('public Worker service binding gateway', () => {
  test('forwards the exact native-sharing allowlist to the private backend', async () => {
    const runtime = gateway()
    const createdResponse = await handleMinimumRuntimeRequest(publicRequest('/api/share/sessions', {
      method: 'POST',
      body: JSON.stringify({ durationMs: 15 * 60_000 }),
    }), runtime.env)
    expect(createdResponse.status).toBe(201)
    const created = await json<CreateSessionResponse>(createdResponse)

    const pointResponse = await handleMinimumRuntimeRequest(publicRequest(
      `/api/share/sessions/${created.sessionId}/points`,
      {
        method: 'POST',
        headers: { 'X-Stracker-Emitter': created.emitterToken },
        body: JSON.stringify({
          version: 1,
          sequence: 1,
          lat: 10.12341,
          lng: 20.56781,
          accuracyM: 8,
          speedMps: 1,
          headingDeg: 30,
          capturedAt: new Date().toISOString(),
        }),
      },
    ), runtime.env)
    expect(pointResponse.status).toBe(202)

    const exchangeResponse = await handleMinimumRuntimeRequest(publicRequest('/api/share/viewer/exchange', {
      method: 'POST',
      body: JSON.stringify({ viewerCapability: created.viewerCapability }),
    }), runtime.env)
    expect(exchangeResponse.status).toBe(200)
    const viewer = await json<ViewerExchangeResponse>(exchangeResponse)

    expect((await handleMinimumRuntimeRequest(publicRequest(`/api/share/sessions/${created.sessionId}/status`, {
      headers: { Authorization: `Bearer ${viewer.viewerSessionToken}` },
    }), runtime.env)).status).toBe(200)
    expect((await handleMinimumRuntimeRequest(publicRequest(`/api/share/sessions/${created.sessionId}/points`, {
      headers: { Authorization: `Bearer ${viewer.viewerSessionToken}` },
    }), runtime.env)).status).toBe(200)
    expect((await handleMinimumRuntimeRequest(publicRequest(`/api/share/sessions/${created.sessionId}/rotate-viewer`, {
      method: 'POST',
      body: '{}',
      headers: { 'X-Stracker-Emitter': created.emitterToken },
    }), runtime.env)).status).toBe(200)
    expect((await handleMinimumRuntimeRequest(publicRequest('/api/share/viewer/logout', {
      method: 'POST',
      body: JSON.stringify({ sessionId: created.sessionId }),
      headers: { Authorization: `Bearer ${viewer.viewerSessionToken}` },
    }), runtime.env)).status).toBe(401)
    expect((await handleMinimumRuntimeRequest(publicRequest(`/api/share/sessions/${created.sessionId}`, {
      method: 'DELETE',
      headers: { 'X-Stracker-Emitter': created.emitterToken },
    }), runtime.env)).status).toBe(200)

    expect(runtime.forwarded.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([
      'POST /api/share/sessions',
      `POST /api/share/sessions/${created.sessionId}/points`,
      'POST /api/share/viewer/exchange',
      `GET /api/share/sessions/${created.sessionId}/status`,
      `GET /api/share/sessions/${created.sessionId}/points`,
      `POST /api/share/sessions/${created.sessionId}/rotate-viewer`,
      'POST /api/share/viewer/logout',
      `DELETE /api/share/sessions/${created.sessionId}`,
    ])
    expect(runtime.forwarded.every((entry) => entry.search === '')).toBe(true)
    expect(runtime.namespace.objects.size).toBe(1)
  })

  test('rejects non-allowlisted paths, methods, queries and cross-origin calls before binding invocation', async () => {
    const runtime = gateway()
    const cases: Array<[Request, number]> = [
      [publicRequest('/api/share/internal'), 404],
      [publicRequest('/api/share/sessions', { method: 'GET' }), 405],
      [publicRequest('/api/share/sessions?token=forbidden', { method: 'POST', body: '{}' }), 400],
      [new Request(`${ORIGIN}/api/share/sessions`, {
        method: 'POST',
        headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' },
        body: '{}',
      }), 403],
    ]
    for (const [request, status] of cases) {
      const response = await handleMinimumRuntimeRequest(request, runtime.env)
      expect(response.status).toBe(status)
      expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0')
    }
    expect(runtime.forwarded).toHaveLength(0)
  })

  test('fails closed when the private service binding is unavailable', async () => {
    const response = await handleMinimumRuntimeRequest(publicRequest('/api/share/sessions', {
      method: 'POST',
      body: '{}',
    }), {})
    expect(response.status).toBe(503)
    expect(await json(response)).toEqual({ status: 'error', error: 'BINDING_UNAVAILABLE' })
  })

  test('serves non-API requests only from the public asset binding', async () => {
    const runtime = gateway()
    const response = await handleMinimumRuntimeRequest(publicRequest('/shared'), runtime.env)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('asset:/shared')
    expect(runtime.forwarded).toHaveLength(0)
  })
})
