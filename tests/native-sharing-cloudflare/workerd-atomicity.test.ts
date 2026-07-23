import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, test } from 'vitest'
import type {
  AcceptedNativePoint,
  CreateSessionInput,
  NativeSharedLocationPoint,
} from '../../native-sharing/src/contracts.js'
import { buildViewerCapability, capabilityVerifier } from '../../native-sharing/src/security.js'
import { MAX_ACTIVE_VIEWER_SESSIONS } from '../../native-sharing-cloudflare/src/runtime-limits.js'
import type { NativeSharingDurableObject } from '../../native-sharing-cloudflare/src/durable-object.js'

const SESSION_ID = 'S'.repeat(43)
const EMITTER_TOKEN = 'E'.repeat(43)
const VIEWER_TOKEN = 'V'.repeat(43)

async function sessionFixture(expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()): Promise<CreateSessionInput> {
  return {
    session: {
      id: SESSION_ID,
      emitterVerifier: await capabilityVerifier(EMITTER_TOKEN),
      viewerVerifier: await capabilityVerifier(VIEWER_TOKEN),
      viewerGeneration: 1,
      state: 'active',
      createdAt: new Date().toISOString(),
      expiresAt,
      revokedAt: null,
      lastSequence: 0,
      lastCapturedAt: null,
      lastReceivedAt: null,
      pointCount: 0,
    },
  }
}

function point(sequence: number): NativeSharedLocationPoint {
  return {
    version: 1,
    sequence,
    lat: 10.1234 + sequence * 0.00001,
    lng: 20.5678 + sequence * 0.00001,
    accuracyM: 8,
    speedMps: 1,
    headingDeg: 30,
    capturedAt: new Date(Date.now() + sequence * 5_000).toISOString(),
  }
}

function stub(name = SESSION_ID) {
  return env.NATIVE_SHARING.getByName(name)
}

async function tableCount(name: string): Promise<number> {
  return runInDurableObject(stub(), async (_instance: NativeSharingDurableObject, state) => {
    const row = state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${name}`).toArray()[0]
    return Number(row?.count ?? 0)
  })
}

describe('Phase B workerd SQLite proof', () => {
  test('EXPORTS_CONFIG_LOADS and SQLITE_SCHEMA_EXISTS', async () => {
    const object = stub()
    const created = await object.createSession(await sessionFixture())
    expect(created.ok).toBe(true)

    const tables = await runInDurableObject(object, async (_instance: NativeSharingDurableObject, state) => {
      return state.storage.sql.exec<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'sharing_session', 'accepted_points', 'viewer_sessions', 'rate_or_sequence_state'
         ) ORDER BY name`,
      ).toArray().map((row) => row.name)
    })
    expect(tables).toEqual(['accepted_points', 'rate_or_sequence_state', 'sharing_session', 'viewer_sessions'])
  })

  test('APPEND_POINT_ROLLBACK and CONDITIONAL_UPDATE_ROWS_WRITTEN', async () => {
    const object = stub()
    expect((await object.createSession(await sessionFixture())).ok).toBe(true)

    await runInDurableObject(object, async (_instance: NativeSharingDurableObject, state) => {
      state.storage.sql.exec(`CREATE TRIGGER synthetic_point_failure
        BEFORE INSERT ON accepted_points
        BEGIN
          SELECT RAISE(ABORT, 'synthetic point insert failure');
        END`)
    })

    const failed = await object.appendPoint(SESSION_ID, EMITTER_TOKEN, point(1))
    expect(failed.ok).toBe(false)

    await runInDurableObject(object, async (_instance: NativeSharingDurableObject, state) => {
      const session = state.storage.sql.exec<{
        last_sequence: number
        point_count: number
      }>('SELECT last_sequence, point_count FROM sharing_session').toArray()[0]
      const sequence = state.storage.sql.exec<{ last_sequence: number }>(
        `SELECT last_sequence FROM rate_or_sequence_state WHERE state_key = 'point-sequence'`,
      ).toArray()[0]
      const points = state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM accepted_points').toArray()[0]
      expect(session).toEqual({ last_sequence: 0, point_count: 0 })
      expect(sequence?.last_sequence).toBe(0)
      expect(Number(points?.count ?? -1)).toBe(0)
      state.storage.sql.exec('DROP TRIGGER synthetic_point_failure')
    })

    const accepted = await object.appendPoint(SESSION_ID, EMITTER_TOKEN, point(1))
    expect(accepted.ok).toBe(true)
    expect(await tableCount('accepted_points')).toBe(1)

    const replay = await object.appendPoint(SESSION_ID, EMITTER_TOKEN, point(1))
    expect(replay.ok).toBe(false)
    expect(await tableCount('accepted_points')).toBe(1)
  })

  test('VIEWER_LIMIT_CONCURRENT', async () => {
    const object = stub()
    expect((await object.createSession(await sessionFixture())).ok).toBe(true)
    const capability = buildViewerCapability(SESSION_ID, VIEWER_TOKEN)
    const attempts = await Promise.all(
      Array.from({ length: MAX_ACTIVE_VIEWER_SESSIONS + 1 }, () => object.exchangeViewerCapability(capability)),
    )
    expect(attempts.filter((result) => result.ok)).toHaveLength(MAX_ACTIVE_VIEWER_SESSIONS)
    expect(attempts.filter((result) => !result.ok && result.code === 'VIEWER_SESSION_QUOTA_EXCEEDED')).toHaveLength(1)
    expect(await tableCount('viewer_sessions')).toBe(MAX_ACTIVE_VIEWER_SESSIONS)
  })

  test('ROTATION_ATOMIC', async () => {
    const object = stub()
    expect((await object.createSession(await sessionFixture())).ok).toBe(true)
    const capability = buildViewerCapability(SESSION_ID, VIEWER_TOKEN)
    expect((await object.exchangeViewerCapability(capability)).ok).toBe(true)
    const rotated = await object.rotateViewer(SESSION_ID, EMITTER_TOKEN)
    expect(rotated.ok).toBe(true)

    await runInDurableObject(object, async (_instance: NativeSharingDurableObject, state) => {
      const session = state.storage.sql.exec<{ viewer_generation: number }>(
        'SELECT viewer_generation FROM sharing_session',
      ).toArray()[0]
      const active = state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM viewer_sessions WHERE revoked_at IS NULL',
      ).toArray()[0]
      expect(session?.viewer_generation).toBe(2)
      expect(Number(active?.count ?? -1)).toBe(0)
    })
  })

  test('REVOCATION_ATOMIC', async () => {
    const object = stub()
    expect((await object.createSession(await sessionFixture())).ok).toBe(true)
    expect((await object.exchangeViewerCapability(buildViewerCapability(SESSION_ID, VIEWER_TOKEN))).ok).toBe(true)
    expect((await object.revoke(SESSION_ID, EMITTER_TOKEN)).ok).toBe(true)

    await runInDurableObject(object, async (_instance: NativeSharingDurableObject, state) => {
      const session = state.storage.sql.exec<{ state: string; revoked_at: string | null }>(
        'SELECT state, revoked_at FROM sharing_session',
      ).toArray()[0]
      const active = state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM viewer_sessions WHERE revoked_at IS NULL',
      ).toArray()[0]
      expect(session?.state).toBe('revoked')
      expect(session?.revoked_at).not.toBeNull()
      expect(Number(active?.count ?? -1)).toBe(0)
    })
  })

  test('ALARM_FAILURE_DELETE_ALL', async () => {
    const object = stub('A'.repeat(43))
    const invalid = await sessionFixture('not-a-date')
    invalid.session.id = 'A'.repeat(43)
    const result = await object.createSession(invalid)
    expect(result).toEqual({ ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' })

    await runInDurableObject(object, async (_instance: NativeSharingDurableObject, state) => {
      const tables = state.storage.sql.exec<{ name: string }>(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'sharing_session', 'accepted_points', 'viewer_sessions', 'rate_or_sequence_state'
         )`,
      ).toArray()
      expect(tables).toEqual([])
      expect(await state.storage.getAlarm()).toBeNull()
    })
  })
})
