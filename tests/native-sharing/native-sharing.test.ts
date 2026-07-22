import { describe, expect, test } from 'bun:test'
import type { AcceptedNativePoint, NativeSharingSession } from '../../native-sharing/src/contracts.js'
import { PointValidationError } from '../../native-sharing/src/geo.js'
import { createNativeSharingHttp } from '../../native-sharing/src/http.js'
import { MAX_POINTS_PER_SESSION } from '../../native-sharing/src/limits.js'
import { capabilityVerifier, parseViewerCapability } from '../../native-sharing/src/security.js'
import { NativeSharingError, NativeSharingService } from '../../native-sharing/src/service.js'
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

describe('native capability model', () => {
  test('EMITTER_VIEWER_TOKEN_SEPARATION', async () => {
    const { service, store } = harness()
    const created = await service.createSession(300_000)
    const viewer = parseViewerCapability(created.viewerCapability)
    expect(viewer).not.toBeNull()
    expect(created.sessionId).toHaveLength(43)
    expect(created.emitterToken).toHaveLength(43)
    expect(viewer?.viewerToken).toHaveLength(43)
    expect(new Set([created.sessionId, created.emitterToken, viewer?.viewerToken]).size).toBe(3)
    const stored = await store.getSession(created.sessionId)
    expect(stored?.emitterVerifier).not.toContain(created.emitterToken)
    expect(stored?.viewerVerifier).not.toContain(viewer?.viewerToken || '')
  })

  test('SESSION_ENUMERATION_BLOCKED', async () => {
    const { service } = harness()
    const created = await service.createSession(300_000)
    const unknown = 'A'.repeat(43)
    await expectCode(service.getStatus(unknown, 'B'.repeat(43)), 'NOT_FOUND')
    await expectCode(service.getStatus(created.sessionId, 'B'.repeat(43)), 'NOT_FOUND')
  })

  test('VIEWER_ROTATION_INVALIDATES_OLD_LINK', async () => {
    const { service } = harness()
    const created = await service.createSession(300_000)
    const oldViewer = parseViewerCapability(created.viewerCapability)
    const rotated = await service.rotateViewer(created.sessionId, created.emitterToken)
    const newViewer = parseViewerCapability(rotated.viewerCapability)
    expect(oldViewer).not.toBeNull()
    expect(newViewer).not.toBeNull()
    await expectCode(service.getStatus(created.sessionId, oldViewer!.viewerToken), 'NOT_FOUND')
    expect((await service.getStatus(created.sessionId, newViewer!.viewerToken)).state).toBe('active')
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
    await expectCode(h.service.appendPoint(created.sessionId, created.emitterToken, point(0, new Date(h.now()).toISOString())), 'REPLAY_REJECTED')
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
  test('REVOCATION_IMMEDIATE', async () => {
    const h = harness()
    const created = await h.service.createSession(300_000)
    const viewer = parseViewerCapability(created.viewerCapability)!
    await h.service.revoke(created.sessionId, created.emitterToken)
    expect((await h.service.getStatus(created.sessionId, viewer.viewerToken)).state).toBe('revoked')
    await expectCode(h.service.getPoints(created.sessionId, viewer.viewerToken), 'SESSION_REVOKED')
    await expectCode(h.service.appendPoint(created.sessionId, created.emitterToken, point(1, new Date(h.now()).toISOString())), 'SESSION_REVOKED')
  })

  test('SESSION_EXPIRATION', async () => {
    const h = harness()
    const created = await h.service.createSession(300_000)
    const viewer = parseViewerCapability(created.viewerCapability)!
    h.advance(300_001)
    expect((await h.service.getStatus(created.sessionId, viewer.viewerToken)).state).toBe('expired')
    await expectCode(h.service.getPoints(created.sessionId, viewer.viewerToken), 'SESSION_EXPIRED')
    await expectCode(h.service.appendPoint(created.sessionId, created.emitterToken, point(1, new Date(h.now()).toISOString())), 'SESSION_EXPIRED')
  })
})

describe('HTTP boundary', () => {
  test('strict JSON, no-store and no open CORS', async () => {
    const h = harness()
    const http = createNativeSharingHttp(h.service)
    const created = await http.fetch(new Request('https://stracker.invalid/api/share/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ durationMs: 300_000 }),
    }))
    expect(created.status).toBe(201)
    expect(created.headers.get('cache-control')).toBe('no-store, max-age=0')
    expect(created.headers.get('access-control-allow-origin')).toBeNull()

    const crossOrigin = await http.fetch(new Request('https://stracker.invalid/api/share/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' },
      body: JSON.stringify({ durationMs: 300_000 }),
    }))
    expect(crossOrigin.status).toBe(403)

    const query = await http.fetch(new Request('https://stracker.invalid/api/share/sessions?guess=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }))
    expect(query.status).toBe(400)
  })

  test('unknown and invalid capabilities have identical public status', async () => {
    const h = harness()
    const http = createNativeSharingHttp(h.service)
    const created = await h.service.createSession(300_000)
    const unknown = await http.fetch(new Request(`https://stracker.invalid/api/share/sessions/${'A'.repeat(43)}/status`, { headers: { 'X-Stracker-Viewer': 'B'.repeat(43) } }))
    const invalid = await http.fetch(new Request(`https://stracker.invalid/api/share/sessions/${created.sessionId}/status`, { headers: { 'X-Stracker-Viewer': 'B'.repeat(43) } }))
    expect(unknown.status).toBe(404)
    expect(invalid.status).toBe(404)
    expect(await unknown.text()).toBe(await invalid.text())
  })

  test('sanitized errors never echo capabilities', async () => {
    const h = harness()
    const http = createNativeSharingHttp(h.service)
    const token = 'T'.repeat(43)
    const response = await http.fetch(new Request(`https://stracker.invalid/api/share/sessions/${'S'.repeat(43)}/status`, { headers: { 'X-Stracker-Viewer': token } }))
    expect(await response.text()).not.toContain(token)
  })
})
