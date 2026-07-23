import { describe, expect, test } from 'bun:test'
import type { AcceptedNativePoint, NativeSharingSession } from '../../native-sharing/src/contracts.js'
import { PointValidationError } from '../../native-sharing/src/geo.js'
import { createNativeSharingHttp } from '../../native-sharing/src/http.js'
import { MAX_POINTS_PER_SESSION, VIEWER_SESSION_TTL_MS } from '../../native-sharing/src/limits.js'
import { capabilityVerifier, parseViewerCapability } from '../../native-sharing/src/security.js'
import { NativeSharingService } from '../../native-sharing/src/service.js'
import { InMemoryNativeSharingStore } from '../../native-sharing/src/store.js'

const START = Date.parse('2026-07-22T12:00:00.000Z')

function harness() {
  let nowMs = START
  const store = new InMemoryNativeSharingStore()
  const service = new NativeSharingService(store, () => new Date(nowMs))
  return {
    store,
    service,
    advance(ms: number) { nowMs += ms },
    now() { return nowMs },
  }
}

function point(sequence: number, capturedAt: string, overrides: Partial<AcceptedNativePoint> = {}) {
  return {
    version: 1 as const,
    sequence,
    lat: 10.1234,
    lng: 20.5678,
    accuracyM: 8,
    speedMps: 0,
    headingDeg: null,
    capturedAt,
    ...overrides,
  }
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code })
}

async function createAndExchange(service: NativeSharingService, durationMs = 300_000) {
  const created = await service.createSession(durationMs)
  const viewer = await service.exchangeViewerCapability(created.viewerCapability)
  return { created, viewer }
}

describe('native capability and opaque viewer sessions', () => {
  test('EMITTER_VIEWER_TOKEN_SEPARATION and CAPABILITY_EXCHANGE_REQUIRED', async () => {
    const { service, store } = harness()
    const created = await service.createSession(300_000)
    const capability = parseViewerCapability(created.viewerCapability)
    expect(capability).not.toBeNull()
    expect(created.sessionId).toHaveLength(43)
    expect(created.emitterToken).toHaveLength(43)
    expect(capability?.viewerToken).toHaveLength(43)
    expect(new Set([created.sessionId, created.emitterToken, capability?.viewerToken]).size).toBe(3)

    const stored = await store.getSession(created.sessionId)
    expect(stored?.emitterVerifier).not.toContain(created.emitterToken)
    expect(stored?.viewerVerifier).not.toContain(capability?.viewerToken || '')
    await expectCode(service.getStatus(created.sessionId, capability!.viewerToken), 'NOT_FOUND')

    const viewer = await service.exchangeViewerCapability(created.viewerCapability)
    expect(viewer.viewerSessionToken).toHaveLength(43)
    expect(viewer.viewerSessionToken).not.toBe(created.emitterToken)
    expect(viewer.viewerSessionToken).not.toBe(capability?.viewerToken)
    expect(viewer.viewerGeneration).toBe(1)
    expect((await service.getStatus(created.sessionId, viewer.viewerSessionToken)).state).toBe('active')
  })

  test('SESSION_ENUMERATION_BLOCKED', async () => {
    const { service } = harness()
    const created = await service.createSession(300_000)
    const parsed = parseViewerCapability(created.viewerCapability)!
    const unknown = `${'A'.repeat(43)}.${'B'.repeat(43)}`
    const invalid = `${created.sessionId}.${'B'.repeat(43)}`
    await expectCode(service.exchangeViewerCapability(unknown), 'NOT_FOUND')
    await expectCode(service.exchangeViewerCapability(invalid), 'NOT_FOUND')
    expect(parsed.viewerToken).not.toBe('B'.repeat(43))
  })

  test('ROTATION_INVALIDATES_ACTIVE_VIEWERS', async () => {
    const { service } = harness()
    const { created, viewer } = await createAndExchange(service)
    expect((await service.getStatus(created.sessionId, viewer.viewerSessionToken)).state).toBe('active')

    const rotated = await service.rotateViewer(created.sessionId, created.emitterToken)
    expect(rotated.viewerGeneration).toBe(2)
    await expectCode(service.exchangeViewerCapability(created.viewerCapability), 'NOT_FOUND')
    await expectCode(service.getStatus(created.sessionId, viewer.viewerSessionToken), 'VIEWER_SESSION_INVALID')

    const replacement = await service.exchangeViewerCapability(rotated.viewerCapability)
    expect(replacement.viewerGeneration).toBe(2)
    expect((await service.getStatus(created.sessionId, replacement.viewerSessionToken)).state).toBe('active')
  })

  test('VIEWER_SESSION_SHORT_LIVED and VIEWER_LOGOUT', async () => {
    const h = harness()
    const first = await createAndExchange(h.service, 60 * 60_000)
    expect(Date.parse(first.viewer.expiresAt) - h.now()).toBe(VIEWER_SESSION_TTL_MS)
    await h.service.logoutViewer(first.created.sessionId, first.viewer.viewerSessionToken)
    await expectCode(h.service.getStatus(first.created.sessionId, first.viewer.viewerSessionToken), 'VIEWER_SESSION_INVALID')

    const second = await createAndExchange(h.service, 60 * 60_000)
    h.advance(VIEWER_SESSION_TTL_MS + 1)
    await expectCode(h.service.getStatus(second.created.sessionId, second.viewer.viewerSessionToken), 'VIEWER_SESSION_EXPIRED')
  })
})

describe('native point acceptance', () => {
  test('REPLAY_BLOCKED and SEQUENCE_ROLLBACK_BLOCKED', async () => {
    const h = harness()
    const created = await h.service.createSession(300_000)
    const first = point(1, new Date(h.now()).toISOString())
    await h.service.appendPoint(created.sessionId, created.emitterToken, first)
    await expect(h.service.appendPoint(created.sessionId, created.emitterToken, first)).rejects.toBeInstanceOf(PointValidationError)
    h.advance(10_000)
    await expectCode(h.service.appendPoint(created.sessionId, created.emitterToken, point(1, new Date(h.now()).toISOString())), 'REPLAY_REJECTED')
  })

  test('IMPOSSIBLE_JUMP_REJECTED', async () => {
    const h = harness()
    const created = await h.service.createSession(300_000)
    await h.service.appendPoint(created.sessionId, created.emitterToken, point(1, new Date(h.now()).toISOString()))
    h.advance(10_000)
    await expectCode(h.service.appendPoint(created.sessionId, created.emitterToken, point(2, new Date(h.now()).toISOString(), { lat: 50 })), 'IMPOSSIBLE_JUMP')
  })

  test('RETENTION_BOUNDED', async () => {
    const h = harness()
    const emitterToken = 'E'.repeat(43)
    const viewerToken = 'V'.repeat(43)
    const session: NativeSharingSession = {
      id: 'S'.repeat(43),
      emitterVerifier: await capabilityVerifier(emitterToken),
      viewerVerifier: await capabilityVerifier(viewerToken),
      viewerGeneration: 1,
      state: 'active',
      createdAt: new Date(h.now()).toISOString(),
      expiresAt: new Date(h.now() + 300_000).toISOString(),
      revokedAt: null,
      lastSequence: MAX_POINTS_PER_SESSION,
      lastCapturedAt: null,
      lastReceivedAt: null,
      pointCount: MAX_POINTS_PER_SESSION,
    }
    await h.store.createSession({ session })
    await expectCode(h.service.appendPoint(session.id, emitterToken, point(MAX_POINTS_PER_SESSION + 1, new Date(h.now()).toISOString())), 'RETENTION_LIMIT')
  })
})

describe('revocation and expiry', () => {
  test('REVOCATION_INVALIDATES_ACTIVE_VIEWERS', async () => {
    const h = harness()
    const { created, viewer } = await createAndExchange(h.service)
    await h.service.revoke(created.sessionId, created.emitterToken)
    await expectCode(h.service.getStatus(created.sessionId, viewer.viewerSessionToken), 'SESSION_REVOKED')
    await expectCode(h.service.getPoints(created.sessionId, viewer.viewerSessionToken), 'SESSION_REVOKED')
    await expectCode(h.service.appendPoint(created.sessionId, created.emitterToken, point(1, new Date(h.now()).toISOString())), 'SESSION_REVOKED')
  })

  test('SESSION_EXPIRATION', async () => {
    const h = harness()
    const { created, viewer } = await createAndExchange(h.service)
    h.advance(300_001)
    await expectCode(h.service.getStatus(created.sessionId, viewer.viewerSessionToken), 'SESSION_EXPIRED')
    await expectCode(h.service.getPoints(created.sessionId, viewer.viewerSessionToken), 'SESSION_EXPIRED')
    await expectCode(h.service.appendPoint(created.sessionId, created.emitterToken, point(1, new Date(h.now()).toISOString())), 'SESSION_EXPIRED')
  })
})

describe('HTTP boundary', () => {
  test('strict JSON, no-store, no-referrer, CSP and no open CORS', async () => {
    const h = harness()
    const http = createNativeSharingHttp(h.service)
    const created = await http.fetch(new Request('https://stracker.invalid/api/share/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationMs: 300_000 }),
    }))
    expect(created.status).toBe(201)
    expect(created.headers.get('cache-control')).toBe('no-store, max-age=0')
    expect(created.headers.get('referrer-policy')).toBe('no-referrer')
    expect(created.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(created.headers.get('access-control-allow-origin')).toBeNull()

    const crossOrigin = await http.fetch(new Request('https://stracker.invalid/api/share/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' },
      body: JSON.stringify({ durationMs: 300_000 }),
    }))
    expect(crossOrigin.status).toBe(403)

    const query = await http.fetch(new Request('https://stracker.invalid/api/share/viewer/exchange?guess=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }))
    expect(query.status).toBe(400)
  })

  test('exchange is required and polling uses Authorization bearer', async () => {
    const h = harness()
    const http = createNativeSharingHttp(h.service)
    const created = await h.service.createSession(300_000)
    const original = parseViewerCapability(created.viewerCapability)!

    const originalPolling = await http.fetch(new Request(`https://stracker.invalid/api/share/sessions/${created.sessionId}/status`, {
      headers: { 'X-Stracker-Viewer': original.viewerToken },
    }))
    expect(originalPolling.status).toBe(404)

    const exchange = await http.fetch(new Request('https://stracker.invalid/api/share/viewer/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerCapability: created.viewerCapability }),
    }))
    expect(exchange.status).toBe(200)
    const exchanged = await exchange.json() as { viewerSessionToken: string; sessionId: string }

    const status = await http.fetch(new Request(`https://stracker.invalid/api/share/sessions/${exchanged.sessionId}/status`, {
      headers: { Authorization: `Bearer ${exchanged.viewerSessionToken}` },
    }))
    expect(status.status).toBe(200)
  })

  test('unknown and invalid capabilities have identical exchange response', async () => {
    const h = harness()
    const http = createNativeSharingHttp(h.service)
    const created = await h.service.createSession(300_000)
    const request = (viewerCapability: string) => http.fetch(new Request('https://stracker.invalid/api/share/viewer/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerCapability }),
    }))
    const unknown = await request(`${'A'.repeat(43)}.${'B'.repeat(43)}`)
    const invalid = await request(`${created.sessionId}.${'B'.repeat(43)}`)
    expect(unknown.status).toBe(404)
    expect(invalid.status).toBe(404)
    expect(await unknown.text()).toBe(await invalid.text())
  })

  test('sanitized errors never echo capabilities or viewer session tokens', async () => {
    const h = harness()
    const http = createNativeSharingHttp(h.service)
    const capability = `${'S'.repeat(43)}.${'T'.repeat(43)}`
    const exchange = await http.fetch(new Request('https://stracker.invalid/api/share/viewer/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerCapability: capability }),
    }))
    expect(await exchange.text()).not.toContain(capability)

    const viewerSessionToken = 'V'.repeat(43)
    const status = await http.fetch(new Request(`https://stracker.invalid/api/share/sessions/${'S'.repeat(43)}/status`, {
      headers: { Authorization: `Bearer ${viewerSessionToken}` },
    }))
    expect(await status.text()).not.toContain(viewerSessionToken)
  })
})
