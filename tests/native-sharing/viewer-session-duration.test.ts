import { describe, expect, test } from 'bun:test'
import { MAX_SESSION_DURATION_MS, VIEWER_SESSION_TTL_MS } from '../../native-sharing/src/limits.js'
import { NativeSharingService } from '../../native-sharing/src/service.js'
import { InMemoryNativeSharingStore } from '../../native-sharing/src/store.js'

const START = Date.parse('2026-08-05T00:00:00.000Z')

function harness() {
  let nowMs = START
  const service = new NativeSharingService(new InMemoryNativeSharingStore(), () => new Date(nowMs))
  return {
    service,
    advance(ms: number) { nowMs += ms },
    now() { return nowMs },
  }
}

describe('viewer session duration', () => {
  test('remains valid for the full maximum sharing duration', async () => {
    const h = harness()
    expect(VIEWER_SESSION_TTL_MS).toBe(MAX_SESSION_DURATION_MS)

    const created = await h.service.createSession(MAX_SESSION_DURATION_MS)
    const viewer = await h.service.exchangeViewerCapability(created.viewerCapability)
    expect(Date.parse(viewer.expiresAt) - h.now()).toBe(MAX_SESSION_DURATION_MS)

    h.advance(MAX_SESSION_DURATION_MS - 1)
    expect((await h.service.getStatus(created.sessionId, viewer.viewerSessionToken)).state).toBe('stale')
  })

  test('is still bounded by the remaining sharing-session lifetime', async () => {
    const h = harness()
    const created = await h.service.createSession(60 * 60_000)
    h.advance(30 * 60_000)

    const viewer = await h.service.exchangeViewerCapability(created.viewerCapability)
    expect(viewer.expiresAt).toBe(created.expiresAt)
    expect(Date.parse(viewer.expiresAt) - h.now()).toBe(30 * 60_000)
  })

  test('immediate revocation still invalidates an active viewer', async () => {
    const h = harness()
    const created = await h.service.createSession(MAX_SESSION_DURATION_MS)
    const viewer = await h.service.exchangeViewerCapability(created.viewerCapability)

    await h.service.revoke(created.sessionId, created.emitterToken)
    await expect(h.service.getStatus(created.sessionId, viewer.viewerSessionToken)).rejects.toMatchObject({ code: 'SESSION_REVOKED' })
  })
})
