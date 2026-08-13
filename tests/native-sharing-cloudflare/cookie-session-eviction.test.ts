import { env, exports } from 'cloudflare:workers'
import { evictDurableObject, reset, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { COOKIE_SESSION_STORAGE_KEY } from '../../native-sharing-cloudflare/src/cookie-session.js'
import type { NativeSharingDurableObject } from '../../native-sharing-cloudflare/src/durable-object.js'

const ORIGIN = 'https://stracker.test'
const raw = JSON.stringify([
  { name: 'SID', value: 'eviction-cookie-secret-one', domain: '.google.com', expirationDate: 1_900_000_000 },
  { name: 'SAPISID', value: 'eviction-cookie-secret-two', domain: '.google.com', expirationDate: 1_900_000_000 },
])

afterEach(async () => { vi.restoreAllMocks(); await reset() })

function request(path: string, method = 'GET', body?: unknown, ownerToken?: string): Request {
  const headers = new Headers()
  if (body !== undefined) headers.set('Content-Type', 'application/json')
  if (ownerToken) headers.set('X-Stracker-Cookie-Owner', ownerToken)
  return new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
}

describe('cookie session Durable Object eviction', () => {
  test('encrypted credentials and session survive eviction until explicit delete', async () => {
    let probe = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const req = new Request(input, init)
      if (req.url.startsWith('https://www.google.com/maps/rpc/locationsharing/read')) {
        probe += 1
        const lng = probe === 1 ? -60.7003 : -60.7000
        const lat = probe === 1 ? -31.6401 : -31.6398
        return new Response(`[null,${lng},${lat}]`, { status: 200 })
      }
      throw new Error(`UNEXPECTED_FETCH_${req.url}`)
    })

    const create = await exports.default.fetch(request('/api/cookie-sessions', 'POST', { raw, durationMs: 60 * 60_000 }))
    expect(create.status).toBe(201)
    const created = await create.json() as { sessionId: string; ownerToken: string; storagePolicy: string }
    expect(created.storagePolicy).toBe('encrypted-durable-object')
    const stub = env.NATIVE_SHARING.getByName(created.sessionId)

    const atRest = await runInDurableObject(stub, async (_instance: NativeSharingDurableObject, state) => {
      const stored = await state.storage.get<Record<string, unknown>>(COOKIE_SESSION_STORAGE_KEY)
      expect(stored).toBeDefined()
      if (stored && 'lastProbeAtMs' in stored) {
        stored.lastProbeAtMs = 0
        await state.storage.put(COOKIE_SESSION_STORAGE_KEY, stored)
      }
      return JSON.stringify(stored)
    })
    expect(atRest).not.toContain('eviction-cookie-secret-one')
    expect(atRest).not.toContain('eviction-cookie-secret-two')
    expect(atRest).not.toContain(created.ownerToken)

    await evictDurableObject(stub)

    const status = await exports.default.fetch(request(`/api/cookie-sessions/${created.sessionId}/status`, 'GET', undefined, created.ownerToken))
    expect(status.status).toBe(200)
    const refresh = await exports.default.fetch(request(`/api/cookie-sessions/${created.sessionId}/refresh`, 'POST', undefined, created.ownerToken))
    expect(refresh.status).toBe(200)
    const point = await exports.default.fetch(request(`/api/cookie-sessions/${created.sessionId}/point`, 'GET', undefined, created.ownerToken))
    expect(point.status).toBe(200)

    const deleted = await exports.default.fetch(request(`/api/cookie-sessions/${created.sessionId}`, 'DELETE', undefined, created.ownerToken))
    expect(deleted.status).toBe(200)
    await evictDurableObject(stub)
    const after = await exports.default.fetch(request(`/api/cookie-sessions/${created.sessionId}/status`, 'GET', undefined, created.ownerToken))
    expect(after.status).toBe(404)
  })
})
