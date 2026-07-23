import { env, runInDurableObject } from 'cloudflare:test'
import { test } from 'vitest'
import type { CreateSessionInput } from '../../native-sharing/src/contracts.js'
import { capabilityVerifier } from '../../native-sharing/src/security.js'
import type { NativeSharingDurableObject } from '../../native-sharing-cloudflare/src/durable-object.js'
import type { RuntimeSqlExecutor, RuntimeSqlRow, RuntimeSqlValue } from '../../native-sharing-cloudflare/src/sqlite-store.js'
import { NativeSharingStoreFault, SqliteNativeSharingStore } from '../../native-sharing-cloudflare/src/sqlite-store.js'

const ID = 'Z'.repeat(43)
const TOKEN = 'T'.repeat(43)

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

test('WORKERD_CREATE_SESSION_DIAGNOSTIC', async () => {
  const now = new Date()
  const input: CreateSessionInput = {
    session: {
      id: ID,
      emitterVerifier: await capabilityVerifier(TOKEN),
      viewerVerifier: await capabilityVerifier('V'.repeat(43)),
      viewerGeneration: 1,
      state: 'active',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      revokedAt: null,
      lastSequence: 0,
      lastCapturedAt: null,
      lastReceivedAt: null,
      pointCount: 0,
    },
  }

  const stage = await runInDurableObject(
    env.NATIVE_SHARING.getByName(ID),
    async (_instance: NativeSharingDurableObject, state) => {
      const store = new SqliteNativeSharingStore(executor(state))
      try {
        await store.createSession(input)
      } catch (error) {
        const code = error instanceof NativeSharingStoreFault ? error.code : 'UNKNOWN'
        return `STORE_${code}`
      }
      try {
        await state.storage.setAlarm(Date.parse(input.session.expiresAt) + 60_000)
      } catch {
        return 'ALARM_FAILURE'
      }
      return 'OK'
    },
  )

  if (stage !== 'OK') throw new Error(stage)
})
