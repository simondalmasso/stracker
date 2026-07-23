import { env, runInDurableObject } from 'cloudflare:test'
import { test } from 'vitest'
import type { NativeSharingDurableObject } from '../../native-sharing-cloudflare/src/durable-object.js'

const ID = 'Z'.repeat(43)
const VERIFIER_A = 'A'.repeat(43)
const VERIFIER_B = 'B'.repeat(43)

test('WORKERD_ROWS_WRITTEN_DIAGNOSTIC', async () => {
  const values = await runInDurableObject(
    env.NATIVE_SHARING.getByName(ID),
    async (_instance: NativeSharingDurableObject, state) => {
      return state.storage.transactionSync(() => {
        const createdAt = new Date().toISOString()
        const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()
        const sessionCursor = state.storage.sql.exec(
          `INSERT INTO sharing_session (
            id, singleton, emitter_verifier, viewer_verifier, viewer_generation, state,
            created_at, expires_at, revoked_at, last_sequence, last_captured_at,
            last_received_at, point_count
          ) VALUES (?, 1, ?, ?, 1, 'active', ?, ?, NULL, 0, NULL, NULL, 0)`,
          ID,
          VERIFIER_A,
          VERIFIER_B,
          createdAt,
          expiresAt,
        )
        sessionCursor.toArray()
        const sessionRowsWritten = sessionCursor.rowsWritten

        const sequenceCursor = state.storage.sql.exec(
          `INSERT INTO rate_or_sequence_state (state_key, last_sequence, updated_at)
           VALUES ('point-sequence', 0, ?)`,
          createdAt,
        )
        sequenceCursor.toArray()
        const sequenceRowsWritten = sequenceCursor.rowsWritten
        return { sessionRowsWritten, sequenceRowsWritten }
      })
    },
  )
  throw new Error(
    `ROWS_WRITTEN_SESSION_${values.sessionRowsWritten}_SEQUENCE_${values.sequenceRowsWritten}`,
  )
})
