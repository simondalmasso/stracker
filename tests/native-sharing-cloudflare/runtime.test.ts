import { afterEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import type { AcceptedNativePoint, CreateSessionResponse, NativeSharedLocationPoint } from '../../native-sharing/src/contracts.js'
import { handleNativeSharingRequest } from '../../native-sharing-cloudflare/src/worker.js'
import {
  MAX_ACTIVE_VIEWER_SESSIONS,
  MAX_POINTS_PER_SESSION,
  RPC_TIMEOUT_MS,
  VIEWER_SESSION_TTL_MS,
} from '../../native-sharing-cloudflare/src/runtime-limits.js'
import type { NativeSharingRpcStub, NativeSharingRuntimeBindings } from '../../native-sharing-cloudflare/src/runtime-contracts.js'
import { NativeSharingStoreFault } from '../../native-sharing-cloudflare/src/sqlite-store.js'
import { TestNativeSharingNamespace, createTestSessionObject, directSession, expectError, testBindings } from './test-runtime.js'

const openNamespaces: TestNativeSharingNamespace[] = []
afterEach(() => {
  while (openNamespaces.length) openNamespaces.pop()?.close()
})

function namespace(now: () => Date = () => new Date()): TestNativeSharingNamespace {
  const value = new TestNativeSharingNamespace(now)
  openNamespaces.push(value)
  return value
}

function apiRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  headers.set('Origin', 'https://stracker.test')
  return new Request(`https://stracker.test${path}`, { ...init, headers })
}

async function createViaWorker(env: NativeSharingRuntimeBindings): Promise<CreateSessionResponse> {
  const response = await handleNativeSharingRequest(apiRequest('/api/share/sessions', {
    method: 'POST',
    body: JSON.stringify({ durationMs: 30 * 60 * 1000 }),
  }), env)
  expect(response.status).toBe(201)
  return response.json() as Promise<CreateSessionResponse>
}

function point(sequence: number, capturedAt = new Date().toISOString()): NativeSharedLocationPoint {
  return {
    version: 1,
    sequence,
    lat: 10.1234 + sequence * 0.00001,
    lng: 20.5678 + sequence * 0.00001,
    accuracyM: 8,
    speedMps: 1,
    headingDeg: 30,
    capturedAt,
  }
}

describe('SQLite Durable Object runtime', () => {
  test('uses declarative SQLite exports and no KV-backed storage calls', async () => {
    const source = await readFile('native-sharing-cloudflare/src/durable-object.ts', 'utf8')
    const config = JSON.parse(await readFile('native-sharing-cloudflare/wrangler.jsonc', 'utf8')) as {
      exports?: Record<string, { type?: string; storage?: string }>
      migrations?: unknown
    }
    expect(source).toContain('this.ctx.storage.sql')
    expect(source).not.toMatch(/storage\.(?:get|put|list)\s*\(/)
    expect(config.exports?.NativeSharingDurableObject).toEqual({ type: 'durable-object', storage: 'sqlite' })
    expect(config).not.toHaveProperty('migrations')
  })

  test('routes one session to one isolated object', async () => {
    const ns = namespace()
    const env = testBindings(ns)
    const first = await createViaWorker(env)
    const second = await createViaWorker(env)
    expect(first.sessionId).not.toBe(second.sessionId)
    expect(ns.objects.size).toBe(2)
    expect(ns.objects.has(first.sessionId)).toBe(true)
    expect(ns.objects.has(second.sessionId)).toBe(true)

    const published = await handleNativeSharingRequest(apiRequest(`/api/share/sessions/${first.sessionId}/points`, {
      method: 'POST',
      headers: { 'X-Stracker-Emitter': first.emitterToken },
      body: JSON.stringify(point(1)),
    }), env)
    expect(published.status).toBe(202)

    const firstObject = ns.objects.get(first.sessionId)
    const secondObject = ns.objects.get(second.sessionId)
    expect((await firstObject?.store.getSession(first.sessionId))?.pointCount).toBe(1)
    expect((await secondObject?.store.getSession(second.sessionId))?.pointCount).toBe(0)
  })

  test('exchanges capability once and polls with opaque viewer session', async () => {
    const ns = namespace()
    const env = testBindings(ns)
    const created = await createViaWorker(env)
    const exchange = await handleNativeSharingRequest(apiRequest('/api/share/viewer/exchange', {
      method: 'POST',
      body: JSON.stringify({ viewerCapability: created.viewerCapability }),
    }), env)
    expect(exchange.status).toBe(200)
    const viewer = await exchange.json() as { sessionId: string; viewerSessionToken: string; viewerGeneration: number; expiresAt: string }
    expect(viewer.sessionId).toBe(created.sessionId)
    expect(viewer.viewerSessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Date.parse(viewer.expiresAt) - Date.now()).toBeLessThanOrEqual(VIEWER_SESSION_TTL_MS)

    const status = await handleNativeSharingRequest(apiRequest(`/api/share/sessions/${created.sessionId}/status`, {
      headers: { Authorization: `Bearer ${viewer.viewerSessionToken}` },
    }), env)
    expect(status.status).toBe(200)
    expect(ns.routedNames.every((name) => name === created.sessionId)).toBe(true)
  })

  test('uses SQLite conditional writes for concurrent point writes', async () => {
    const fixed = new Date('2026-07-22T20:00:00.000Z')
    const object = createTestSessionObject(() => fixed)
    const created = await directSession(object.runtime, fixed)
    const acceptedPoint: AcceptedNativePoint = {
      ...point(1, fixed.toISOString()),
      receivedAt: fixed.toISOString(),
      sessionId: created.input.session.id,
      acceptanceState: 'accepted',
    }

    const first = await object.store.appendPoint(created.input.session.id, 0, acceptedPoint)
    expect(first.point.sequence).toBe(1)

    let secondFailure: unknown = null
    try {
      await object.store.appendPoint(created.input.session.id, 0, acceptedPoint)
    } catch (error) {
      secondFailure = error
    }
    expect(secondFailure).toBeInstanceOf(NativeSharingStoreFault)
    expect((secondFailure as NativeSharingStoreFault).code).toBe('SEQUENCE_RACE')

    const session = object.sql.database.query(
      'SELECT point_count, last_sequence FROM sharing_session WHERE id = ?',
    ).get(created.input.session.id) as { point_count: number; last_sequence: number }
    const pointRows = object.sql.database.query(
      'SELECT COUNT(*) AS count FROM accepted_points',
    ).get() as { count: number }
    const sequenceState = object.sql.database.query(
      `SELECT last_sequence FROM rate_or_sequence_state WHERE state_key = 'point-sequence'`,
    ).get() as { last_sequence: number }

    expect(session).toEqual({ point_count: 1, last_sequence: 1 })
    expect(pointRows.count).toBe(1)
    expect(sequenceState.last_sequence).toBe(1)
    object.sql.close()
  })

  test('rotation and revocation invalidate active viewer sessions immediately', async () => {
    const now = new Date('2026-07-22T20:00:00.000Z')
    const object = createTestSessionObject(() => now)
    const created = await directSession(object.runtime, now)
    const exchange = await object.runtime.exchangeViewerCapability(created.viewerCapability)
    if (!exchange.ok) throw new Error(exchange.code)
    expect((await object.runtime.getStatus(created.input.session.id, exchange.value.viewerSessionToken)).ok).toBe(true)

    const rotated = await object.runtime.rotateViewer(created.input.session.id, created.emitterToken)
    expect(rotated.ok).toBe(true)
    expectError(await object.runtime.getStatus(created.input.session.id, exchange.value.viewerSessionToken), 'VIEWER_SESSION_INVALID')
    if (!rotated.ok) throw new Error(rotated.code)
    const replacement = await object.runtime.exchangeViewerCapability(rotated.value.viewerCapability)
    if (!replacement.ok) throw new Error(replacement.code)

    expect((await object.runtime.revoke(created.input.session.id, created.emitterToken)).ok).toBe(true)
    expectError(await object.runtime.getStatus(created.input.session.id, replacement.value.viewerSessionToken), 'SESSION_REVOKED')
    object.sql.close()
  })

  test('enforces viewer and point quotas without hidden data loss', async () => {
    const fixed = new Date('2026-07-22T20:00:00.000Z')
    const object = createTestSessionObject(() => fixed)
    const created = await directSession(object.runtime, fixed)
    for (let index = 0; index < MAX_ACTIVE_VIEWER_SESSIONS; index += 1) {
      expect((await object.runtime.exchangeViewerCapability(created.viewerCapability)).ok).toBe(true)
    }
    expectError(await object.runtime.exchangeViewerCapability(created.viewerCapability), 'VIEWER_SESSION_QUOTA_EXCEEDED')

    object.sql.database.query('UPDATE sharing_session SET point_count = ? WHERE id = ?').run(MAX_POINTS_PER_SESSION, created.input.session.id)
    expectError(await object.runtime.appendPoint(created.input.session.id, created.emitterToken, point(1, fixed.toISOString())), 'POINT_QUOTA_EXCEEDED')
    expect((await object.store.getSession(created.input.session.id))?.pointCount).toBe(MAX_POINTS_PER_SESSION)
    expect(await object.store.getLatestPoint(created.input.session.id)).toBeNull()
    object.sql.close()
  })

  test('expires sessions and viewer tokens independently', async () => {
    let now = new Date('2026-07-22T20:00:00.000Z')
    const object = createTestSessionObject(() => now)
    const created = await directSession(object.runtime, now, 5 * 60 * 1000)
    const exchange = await object.runtime.exchangeViewerCapability(created.viewerCapability)
    if (!exchange.ok) throw new Error(exchange.code)
    now = new Date(now.getTime() + 5 * 60 * 1000 + 1)
    expectError(await object.runtime.getStatus(created.input.session.id, exchange.value.viewerSessionToken), 'SESSION_EXPIRED')
    object.sql.close()
  })
})

describe('Worker HTTP boundary', () => {
  test('rejects invalid origin, query capabilities, methods and oversized bodies', async () => {
    const ns = namespace()
    const env = testBindings(ns)
    const crossOrigin = new Request('https://stracker.test/api/share/sessions', {
      method: 'POST',
      headers: { Origin: 'https://attacker.test', 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect((await handleNativeSharingRequest(crossOrigin, env)).status).toBe(403)
    expect((await handleNativeSharingRequest(apiRequest('/api/share/sessions?token=synthetic', { method: 'POST', body: '{}' }), env)).status).toBe(400)
    expect((await handleNativeSharingRequest(apiRequest('/api/share/sessions', { method: 'GET' }), env)).status).toBe(405)
    expect((await handleNativeSharingRequest(apiRequest('/api/share/sessions', {
      method: 'POST',
      body: JSON.stringify({ value: 'x'.repeat(17 * 1024) }),
    }), env)).status).toBe(413)
  })

  test('fails closed when bindings or storage are unavailable', async () => {
    expect((await handleNativeSharingRequest(apiRequest('/api/share/sessions', { method: 'POST', body: '{}' }), {})).status).toBe(503)

    const failingStub: NativeSharingRpcStub = {
      createSession: async () => ({ ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }),
      appendPoint: async () => ({ ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }),
      exchangeViewerCapability: async () => ({ ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }),
      getStatus: async () => ({ ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }),
      getPoints: async () => ({ ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }),
      logoutViewer: async () => ({ ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }),
      rotateViewer: async () => ({ ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }),
      revoke: async () => ({ ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }),
    }
    const env: NativeSharingRuntimeBindings = { NATIVE_SHARING: { getByName: () => failingStub } }
    expect((await handleNativeSharingRequest(apiRequest('/api/share/sessions', { method: 'POST', body: '{}' }), env)).status).toBe(503)
  })

  test('rejects late RPC responses at the Worker timeout boundary', async () => {
    const delayed = new Promise<never>(() => {})
    const stub: NativeSharingRpcStub = {
      createSession: () => delayed,
      appendPoint: () => delayed,
      exchangeViewerCapability: () => delayed,
      getStatus: () => delayed,
      getPoints: () => delayed,
      logoutViewer: () => delayed,
      rotateViewer: () => delayed,
      revoke: () => delayed,
    }
    const env: NativeSharingRuntimeBindings = { NATIVE_SHARING: { getByName: () => stub } }
    const started = Date.now()
    const response = await handleNativeSharingRequest(apiRequest('/api/share/sessions', { method: 'POST', body: '{}' }), env)
    expect(response.status).toBe(504)
    expect(Date.now() - started).toBeGreaterThanOrEqual(RPC_TIMEOUT_MS - 100)
  })

  test('serves static assets only through the asset binding', async () => {
    const env = testBindings(namespace())
    const response = await handleNativeSharingRequest(new Request('https://stracker.test/shared'), env)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('asset:/shared')
  })
})
