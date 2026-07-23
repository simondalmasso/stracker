import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, test } from 'vitest'
import type {
  AcceptedNativePoint,
  CreateSessionInput,
  NativeSharedLocationPoint,
  OpaqueViewerSession,
} from '../../native-sharing/src/contracts.js'
import { buildViewerCapability, capabilityVerifier } from '../../native-sharing/src/security.js'
import type { NativeSharingDurableObject } from '../../native-sharing-cloudflare/src/durable-object.js'
import { MAX_ACTIVE_VIEWER_SESSIONS } from '../../native-sharing-cloudflare/src/runtime-limits.js'
import type { RuntimeSqlExecutor, RuntimeSqlRow, RuntimeSqlValue } from '../../native-sharing-cloudflare/src/sqlite-store.js'
import { NativeSharingStoreFault, SqliteNativeSharingStore } from '../../native-sharing-cloudflare/src/sqlite-store.js'

const EMITTER_TOKEN = 'E'.repeat(43)
const VIEWER_TOKEN = 'V'.repeat(43)

function sessionId(character: string): string {
  return character.repeat(43)
}

function stub(character: string) {
  return env.NATIVE_SHARING.getByName(sessionId(character))
}

async function sessionFixture(character: string, expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()): Promise<CreateSessionInput> {
  const id = sessionId(character)
  return {
    session: {
      id,
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
    capturedAt: new Date().toISOString(),
  }
}

function executor(state: DurableObjectState): RuntimeSqlExecutor {
  return {
    exec<T extends RuntimeSqlRow = RuntimeSqlRow>(query: string, ...bindings: RuntimeSqlValue[]) {
      return state.storage.sql.exec<T>(query, ...bindings)
    },
    transactionSync<T>(callback: () => T): T {
      return state.storage.transactionSync(callback)
    },
  }
}

async function countRows(character: string, table: string): Promise<number> {
  return runInDurableObject(stub(character), async (_instance: NativeSharingDurableObject, state) => {
    const row = state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).toArray()[0]
    return Number(row?.count ?? 0)
  })
}

describe('Phase B workerd SQLite proof', () => {
  test('EXPORTS_CONFIG_LOADS and SQLITE_SCHEMA_EXISTS', async () => {
    const object = stub('A')
    expect((await object.createSession(await sessionFixture('A'))).ok).toBe(true)

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

  test('CREATE_SESSION_TWO_INSERT_ROLLBACK', async () => {
    const object = stub('B')
    await runInDurableObject(object, async (_instance: NativeSharingDurableObject, state) => {
      state.storage.sql.exec(`CREATE TRIGGER synthetic_sequence_state_failure
        BEFORE INSERT ON rate_or_sequence_state
        BEGIN
          SELECT RAISE(ABORT, 'synthetic sequence state failure');
        END`)
    })

    const result = await object.createSession(await sessionFixture('B'))
    expect(result).toEqual({ ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' })

    await runInDurableObject(object, async (_instance: NativeSharingDurableObject, state) => {
      const sessions = state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM sharing_session').toArray()[0]
      const sequenceStates = state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM rate_or_sequence_state').toArray()[0]
      expect(Number(sessions?.count ?? -1)).toBe(0)
      expect(Number(sequenceStates?.count ?? -1)).toBe(0)
    })
  })

  test('APPEND_POINT_ROLLBACK', async () => {
    const object = stub('C')
    expect((await object.createSession(await sessionFixture('C'))).ok).toBe(true)

    await runInDurableObject(object, async (_instance: NativeSharingDurableObject, state) => {
      state.storage.sql.exec(`CREATE TRIGGER synthetic_point_failure
        BEFORE INSERT ON accepted_points
        BEGIN
          SELECT RAISE(ABORT, 'synthetic point insert failure');
        END`)
    })

    expect((await object.appendPoint(sessionId('C'), EMITTER_TOKEN, point(1))).ok).toBe(false)

    await runInDurableObject(object, async (_instance: NativeSharingDurableObject, state) => {
      const session = state.storage.sql.exec<{ last_sequence: number; point_count: number }>(
        'SELECT last_sequence, point_count FROM sharing_session',
      ).toArray()[0]
      const sequence = state.storage.sql.exec<{ last_sequence: number }>(
        `SELECT last_sequence FROM rate_or_sequence_state WHERE state_key = 'point-sequence'`,
      ).toArray()[0]
      const points = state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM accepted_points').toArray()[0]
      expect(session).toEqual({ last_sequence: 0, point_count: 0 })
      expect(sequence?.last_sequence).toBe(0)
      expect(Number(points?.count ?? -1)).toBe(0)
    })
  })

  test('APPEND_POINT_ROWS_WRITTEN_RACE', async () => {
    const object = stub('D')
    expect((await object.createSession(await sessionFixture('D'))).ok).toBe(true)

    await runInDurableObject(object, async (_instance: NativeSharingDurableObject, state) => {
      state.storage.sql.exec(`CREATE TRIGGER synthetic_conditional_update_ignore
        BEFORE UPDATE OF last_sequence ON sharing_session
        WHEN NEW.last_sequence > OLD.last_sequence
        BEGIN
          SELECT RAISE(IGNORE);
        END`)
    })

    const result = await object.appendPoint(sessionId('D'), EMITTER_TOKEN, point(1))
    expect(result).toEqual({ ok: false, status: 409, code: 'SEQUENCE_RACE' })
    expect(await countRows('D', 'accepted_points')).toBe(0)

    await runInDurableObject(object, async (_instance: NativeSharingDurableObject, state) => {
      const session = state.storage.sql.exec<{ last_sequence: number; point_count: number }>(
        'SELECT last_sequence, point_count FROM sharing_session',
      ).toArray()[0]
      expect(session).toEqual({ last_sequence: 0, point_count: 0 })
    })
  })

  test('VIEWER_EXCHANGE_GENERATION_RACE', async () => {
    const object = stub('F')
    expect((await object.createSession(await sessionFixture('F'))).ok).toBe(true)
    const staleViewerVerifier = await capabilityVerifier(VIEWER_TOKEN)
    const opaqueVerifier = await capabilityVerifier('T'.repeat(43))
    const nowIso = new Date().toISOString()

    const code = await runInDurableObject(object, async (_instance: NativeSharingDurableObject, state) => {
      const store = new SqliteNativeSharingStore(executor(state))
      const preverified = await store.getSession(sessionId('F'))
      expect(preverified?.viewerGeneration).toBe(1)
      expect(preverified?.viewerVerifier).toBe(staleViewerVerifier)

      const rotatedVerifier = await capabilityVerifier('R'.repeat(43))
      state.storage.sql.exec(
        `UPDATE sharing_session
         SET viewer_verifier = ?, viewer_generation = viewer_generation + 1
         WHERE id = ?`,
        rotatedVerifier,
        sessionId('F'),
      ).toArray()

      const viewerSession: OpaqueViewerSession = {
        tokenVerifier: opaqueVerifier,
        sharingSessionId: sessionId('F'),
        viewerGeneration: 1,
        createdAt: nowIso,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        revokedAt: null,
      }
      try {
        await store.createViewerSession(sessionId('F'), viewerSession, {
          sessionId: sessionId('F'),
          expectedViewerVerifier: staleViewerVerifier,
          expectedViewerGeneration: 1,
          nowIso,
        })
        return 'UNEXPECTED_INSERT'
      } catch (error) {
        return error instanceof NativeSharingStoreFault ? error.code : 'UNEXPECTED_ERROR'
      }
    })

    expect(code).toBe('VIEWER_GENERATION_RACE')
    expect(await countRows('F', 'viewer_sessions')).toBe(0)
  })

  test('VIEWER_LIMIT_CONCURRENT', async () => {
    const object = stub('G')
    expect((await object.createSession(await sessionFixture('G'))).ok).toBe(true)
    const capability = buildViewerCapability(sessionId('G'), VIEWER_TOKEN)
    const attempts = await Promise.all(
      Array.from({ length: MAX_ACTIVE_VIEWER_SESSIONS + 1 }, () => object.exchangeViewerCapability(capability)),
    )
    expect(attempts.filter((result) => result.ok)).toHaveLength(MAX_ACTIVE_VIEWER_SESSIONS)
    expect(attempts.filter((result) => !result.ok && result.code === 'VIEWER_SESSION_QUOTA_EXCEEDED')).toHaveLength(1)
    expect(await countRows('G', 'viewer_sessions')).toBe(MAX_ACTIVE_VIEWER_SESSIONS)
  })

  test('ROTATION_ATOMIC', async () => {
    const object = stub('H')
    expect((await object.createSession(await sessionFixture('H'))).ok).toBe(true)
    expect((await object.exchangeViewerCapability(buildViewerCapability(sessionId('H'), VIEWER_TOKEN))).ok).toBe(true)
    expect((await object.rotateViewer(sessionId('H'), EMITTER_TOKEN)).ok).toBe(true)

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
    const object = stub('I')
    expect((await object.createSession(await sessionFixture('I'))).ok).toBe(true)
    expect((await object.exchangeViewerCapability(buildViewerCapability(sessionId('I'), VIEWER_TOKEN))).ok).toBe(true)
    expect((await object.revoke(sessionId('I'), EMITTER_TOKEN)).ok).toBe(true)

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

  test('SET_ALARM_FAILURE_DELETE_ALL', async () => {
    const object = stub('J')
    await runInDurableObject(object, async (instance: NativeSharingDurableObject) => {
      const testable = instance as unknown as { testSetAlarmFailure: boolean }
      testable.testSetAlarmFailure = true
    })

    const result = await object.createSession(await sessionFixture('J'))
    expect(result).toEqual({ ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' })

    await runInDurableObject(object, async (_instance: NativeSharingDurableObject, state) => {
      const counts = {
        sessions: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM sharing_session').toArray()[0]?.count ?? -1,
        points: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM accepted_points').toArray()[0]?.count ?? -1,
        viewers: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM viewer_sessions').toArray()[0]?.count ?? -1,
        sequenceStates: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM rate_or_sequence_state').toArray()[0]?.count ?? -1,
      }
      expect(counts).toEqual({ sessions: 0, points: 0, viewers: 0, sequenceStates: 0 })
      expect(await state.storage.getAlarm()).toBeNull()
    })
  })

  test('ALARM_CLEANUP_VERIFICATION_FAILURE', async () => {
    const object = stub('K')
    expect((await object.createSession(await sessionFixture('K'))).ok).toBe(true)

    const message = await runInDurableObject(object, async (instance: NativeSharingDurableObject, state) => {
      state.storage.sql.exec(
        'UPDATE sharing_session SET expires_at = ? WHERE id = ?',
        '1970-01-01T00:00:00.000Z',
        sessionId('K'),
      ).toArray()
      const testable = instance as unknown as { testCleanupVerificationOverride: false | null }
      testable.testCleanupVerificationOverride = false
      try {
        await instance.alarm()
        return 'SILENT_SUCCESS'
      } catch (error) {
        return error instanceof Error ? error.message : 'UNKNOWN_ERROR'
      }
    })

    expect(message).toBe('STORAGE_CLEANUP_UNVERIFIED')
  })
})
