import { env, exports } from 'cloudflare:workers'
import { reset, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, test } from 'vitest'
import type {
  CreateSessionResponse,
  NativeSharedLocationPoint,
  ViewerExchangeResponse,
  ViewerPointsResponse,
  ViewerStatusResponse,
} from '../../native-sharing/src/contracts.js'
import type { NativeSharingDurableObject } from '../../native-sharing-cloudflare/src/durable-object.js'

const ORIGIN = 'https://stracker.test'
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/
const VIEWER_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/

interface ErrorPayload {
  status: 'error'
  error: string
}

interface RotateResponse {
  viewerCapability: string
  viewerGeneration: number
}

async function dispatch(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, init))
}

function jsonRequest(method: string, body: unknown, headers?: HeadersInit): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  }
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

function expectSanitizedApiHeaders(response: Response): void {
  expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0')
  expect(response.headers.get('Pragma')).toBe('no-cache')
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status)
  expectSanitizedApiHeaders(response)
  expect(await json<ErrorPayload>(response)).toEqual({ status: 'error', error: code })
}

function syntheticPoint(sequence: number): NativeSharedLocationPoint {
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

afterEach(async () => {
  await reset()
})

describe('Worker HTTP to Durable Object SQLite integration', () => {
  test('WORKER_SQLITE_E2E_CREATE_PUBLISH_EXCHANGE_ROTATE_REVOKE', async () => {
    const createResponse = await dispatch('/api/share/sessions', jsonRequest('POST', {}))
    expect(createResponse.status).toBe(201)
    expectSanitizedApiHeaders(createResponse)
    const created = await json<CreateSessionResponse>(createResponse)

    expect(created.sessionId).toMatch(CAPABILITY_PATTERN)
    expect(created.emitterToken).toMatch(CAPABILITY_PATTERN)
    expect(created.viewerCapability).toMatch(VIEWER_CAPABILITY_PATTERN)
    expect(Number.isFinite(Date.parse(created.expiresAt))).toBe(true)

    const [, initialViewerToken] = created.viewerCapability.split('.')
    const createdStorage = await runInDurableObject(
      env.NATIVE_SHARING.getByName(created.sessionId),
      async (_instance: NativeSharingDurableObject, state) => {
        const tables = state.storage.sql.exec<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN (
             'sharing_session', 'accepted_points', 'viewer_sessions', 'rate_or_sequence_state'
           ) ORDER BY name`,
        ).toArray().map((row) => row.name)
        const session = state.storage.sql.exec<{
          id: string
          emitter_verifier: string
          viewer_verifier: string
          viewer_generation: number
          point_count: number
        }>(
          `SELECT id, emitter_verifier, viewer_verifier, viewer_generation, point_count
           FROM sharing_session LIMIT 1`,
        ).toArray()[0]
        const sequenceCount = state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM rate_or_sequence_state',
        ).toArray()[0]?.count ?? -1
        return { tables, session, sequenceCount }
      },
    )

    expect(createdStorage.tables).toEqual([
      'accepted_points',
      'rate_or_sequence_state',
      'sharing_session',
      'viewer_sessions',
    ])
    expect(createdStorage.session).toMatchObject({
      id: created.sessionId,
      viewer_generation: 1,
      point_count: 0,
    })
    expect(createdStorage.session?.emitter_verifier).toMatch(CAPABILITY_PATTERN)
    expect(createdStorage.session?.viewer_verifier).toMatch(CAPABILITY_PATTERN)
    expect(createdStorage.session?.emitter_verifier).not.toBe(created.emitterToken)
    expect(createdStorage.session?.viewer_verifier).not.toBe(initialViewerToken)
    expect(Number(createdStorage.sequenceCount)).toBe(1)

    const publishResponse = await dispatch(
      `/api/share/sessions/${created.sessionId}/points`,
      jsonRequest('POST', syntheticPoint(1), { 'X-Stracker-Emitter': created.emitterToken }),
    )
    expect(publishResponse.status).toBe(202)
    expectSanitizedApiHeaders(publishResponse)
    const published = await json<{ status: 'ok'; point: { sequence: number; acceptanceState: string } }>(publishResponse)
    expect(published).toMatchObject({ status: 'ok', point: { sequence: 1, acceptanceState: 'accepted' } })

    const exchangeResponse = await dispatch(
      '/api/share/viewer/exchange',
      jsonRequest('POST', { viewerCapability: created.viewerCapability }),
    )
    expect(exchangeResponse.status).toBe(200)
    expectSanitizedApiHeaders(exchangeResponse)
    const exchanged = await json<ViewerExchangeResponse>(exchangeResponse)
    expect(exchanged.sessionId).toBe(created.sessionId)
    expect(exchanged.viewerSessionToken).toMatch(CAPABILITY_PATTERN)
    expect(exchanged.viewerGeneration).toBe(1)

    const statusResponse = await dispatch(`/api/share/sessions/${created.sessionId}/status`, {
      headers: { Authorization: `Bearer ${exchanged.viewerSessionToken}` },
    })
    expect(statusResponse.status).toBe(200)
    const status = await json<ViewerStatusResponse>(statusResponse)
    expect(status).toMatchObject({ state: 'active', pointCount: 1 })
    expect(status.lastUpdate).not.toBeNull()

    const pointsResponse = await dispatch(`/api/share/sessions/${created.sessionId}/points`, {
      headers: { Authorization: `Bearer ${exchanged.viewerSessionToken}` },
    })
    expect(pointsResponse.status).toBe(200)
    const points = await json<ViewerPointsResponse>(pointsResponse)
    expect(points.state).toBe('active')
    expect(points.points).toHaveLength(1)
    expect(points.points[0]).toMatchObject({ sequence: 1, sessionId: created.sessionId, acceptanceState: 'accepted' })
    expect(points.segments).toHaveLength(1)

    const persisted = await runInDurableObject(
      env.NATIVE_SHARING.getByName(created.sessionId),
      async (_instance: NativeSharingDurableObject, state) => {
        const session = state.storage.sql.exec<{
          last_sequence: number
          point_count: number
          viewer_generation: number
        }>('SELECT last_sequence, point_count, viewer_generation FROM sharing_session').toArray()[0]
        const pointCount = state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM accepted_points',
        ).toArray()[0]?.count ?? -1
        const viewer = state.storage.sql.exec<{
          token_verifier: string
          viewer_generation: number
          revoked_at: string | null
        }>('SELECT token_verifier, viewer_generation, revoked_at FROM viewer_sessions LIMIT 1').toArray()[0]
        return { session, pointCount, viewer }
      },
    )

    expect(persisted.session).toEqual({ last_sequence: 1, point_count: 1, viewer_generation: 1 })
    expect(Number(persisted.pointCount)).toBe(1)
    expect(persisted.viewer).toMatchObject({ viewer_generation: 1, revoked_at: null })
    expect(persisted.viewer?.token_verifier).toMatch(CAPABILITY_PATTERN)
    expect(persisted.viewer?.token_verifier).not.toBe(exchanged.viewerSessionToken)

    const rotateResponse = await dispatch(`/api/share/sessions/${created.sessionId}/rotate-viewer`, {
      ...jsonRequest('POST', {}, { 'X-Stracker-Emitter': created.emitterToken }),
    })
    expect(rotateResponse.status).toBe(200)
    const rotated = await json<RotateResponse>(rotateResponse)
    expect(rotated.viewerGeneration).toBe(2)
    expect(rotated.viewerCapability).toMatch(VIEWER_CAPABILITY_PATTERN)
    expect(rotated.viewerCapability).not.toBe(created.viewerCapability)

    await expectError(
      await dispatch(`/api/share/sessions/${created.sessionId}/status`, {
        headers: { Authorization: `Bearer ${exchanged.viewerSessionToken}` },
      }),
      401,
      'VIEWER_SESSION_INVALID',
    )

    const rotatedExchangeResponse = await dispatch(
      '/api/share/viewer/exchange',
      jsonRequest('POST', { viewerCapability: rotated.viewerCapability }),
    )
    expect(rotatedExchangeResponse.status).toBe(200)
    const rotatedExchange = await json<ViewerExchangeResponse>(rotatedExchangeResponse)
    expect(rotatedExchange.viewerGeneration).toBe(2)
    expect(rotatedExchange.viewerSessionToken).toMatch(CAPABILITY_PATTERN)

    const revokeResponse = await dispatch(`/api/share/sessions/${created.sessionId}`, {
      method: 'DELETE',
      headers: { 'X-Stracker-Emitter': created.emitterToken },
    })
    expect(revokeResponse.status).toBe(200)
    expect(await json<{ status: string; state: string }>(revokeResponse)).toEqual({ status: 'ok', state: 'revoked' })

    await expectError(
      await dispatch(`/api/share/sessions/${created.sessionId}/status`, {
        headers: { Authorization: `Bearer ${rotatedExchange.viewerSessionToken}` },
      }),
      410,
      'SESSION_REVOKED',
    )
    await expectError(
      await dispatch(
        `/api/share/sessions/${created.sessionId}/points`,
        jsonRequest('POST', syntheticPoint(2), { 'X-Stracker-Emitter': created.emitterToken }),
      ),
      410,
      'SESSION_REVOKED',
    )

    const revokedStorage = await runInDurableObject(
      env.NATIVE_SHARING.getByName(created.sessionId),
      async (_instance: NativeSharingDurableObject, state) => {
        const session = state.storage.sql.exec<{
          state: string
          viewer_generation: number
          revoked_at: string | null
          point_count: number
        }>('SELECT state, viewer_generation, revoked_at, point_count FROM sharing_session').toArray()[0]
        const activeViewers = state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM viewer_sessions WHERE revoked_at IS NULL',
        ).toArray()[0]?.count ?? -1
        const totalViewers = state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM viewer_sessions',
        ).toArray()[0]?.count ?? -1
        const staleGenerationViewers = state.storage.sql.exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM viewer_sessions WHERE viewer_generation = 1',
        ).toArray()[0]?.count ?? -1
        return { session, activeViewers, totalViewers, staleGenerationViewers }
      },
    )

    expect(revokedStorage.session).toMatchObject({ state: 'revoked', viewer_generation: 2, point_count: 1 })
    expect(revokedStorage.session?.revoked_at).not.toBeNull()
    expect(Number(revokedStorage.activeViewers)).toBe(0)
    expect(Number(revokedStorage.totalViewers)).toBe(1)
    expect(Number(revokedStorage.staleGenerationViewers)).toBe(0)
  })

  test('WORKER_HTTP_BOUNDARY_FAILS_CLOSED_WITH_SANITIZED_ERRORS', async () => {
    await expectError(
      await dispatch('/api/share/sessions', jsonRequest('POST', {}, { Origin: 'https://cross-origin.invalid' })),
      403,
      'ORIGIN_REJECTED',
    )
    await expectError(await dispatch('/api/share/sessions?unexpected=1', jsonRequest('POST', {})), 400, 'REQUEST_INVALID')
    await expectError(await dispatch('/api/share/sessions', { method: 'GET' }), 405, 'METHOD_NOT_ALLOWED')
    await expectError(
      await dispatch('/api/share/sessions', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }),
      415,
      'CONTENT_TYPE_REQUIRED',
    )
    await expectError(
      await dispatch(`/api/share/sessions/${'A'.repeat(43)}/status`, {
        headers: { Authorization: `Bearer ${'B'.repeat(43)}` },
      }),
      404,
      'NOT_FOUND',
    )
  })
})
