import { env } from 'cloudflare:test'
import { test } from 'vitest'
import { capabilityVerifier } from '../../native-sharing/src/security.js'

const ID = 'Z'.repeat(43)
const TOKEN = 'T'.repeat(43)

test('WORKERD_CREATE_SESSION_DIAGNOSTIC', async () => {
  const now = new Date()
  const result = await env.NATIVE_SHARING.getByName(ID).createSession({
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
  })
  if (!result.ok) throw new Error(`CREATE_SESSION_RESULT_${result.code}`)
})
