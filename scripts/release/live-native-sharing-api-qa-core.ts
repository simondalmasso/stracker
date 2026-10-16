export {}

const target = new URL(process.env.STRACKER_QA_URL || '')
const expectedSha = process.env.STRACKER_EXPECTED_SHA || ''
const expectedVersionId = process.env.STRACKER_EXPECTED_VERSION_ID || ''
const overrideVersion = process.env.STRACKER_VERSION_OVERRIDE || ''
const output = process.env.STRACKER_API_QA_OUTPUT || '/tmp/stracker-native-sharing-api-qa.json'
const expectedRelease = process.env.STRACKER_EXPECTED_RELEASE || 'native-sharing-live-synthetic-v1'
const RUNTIME_IDENTITY_ATTEMPTS = 20

if (target.protocol !== 'https:' || !target.hostname) throw new Error('HTTPS_TARGET_REQUIRED')
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('EXPECTED_SHA_REQUIRED')
if (!expectedVersionId) throw new Error('EXPECTED_VERSION_ID_REQUIRED')

const CAPABILITY = /^[A-Za-z0-9_-]{43}$/
const VIEWER_CAPABILITY = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/

class QaFailure extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function ok(value: unknown, code: string): asserts value {
  if (!value) throw new QaFailure(code)
}

function headers(init: HeadersInit = {}): Headers {
  const value = new Headers(init)
  value.set('Accept', 'application/json')
  value.set('Cache-Control', 'no-cache')
  if (overrideVersion) value.set('Cloudflare-Workers-Version-Overrides', `stracker="${overrideVersion}"`)
  return value
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(new URL(path, target), {
    ...init,
    headers: headers(init.headers),
    cache: 'no-store',
    redirect: 'error',
  })
}

async function payload<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => null)
  ok(value !== null, 'NON_JSON_RESPONSE')
  return value as T
}

async function expectError(response: Response, statuses: number[], codes: string[]): Promise<void> {
  ok(statuses.includes(response.status), 'ERROR_STATUS_UNEXPECTED')
  const value = await payload<{ status?: string; error?: string }>(response)
  ok(value.status === 'error' && typeof value.error === 'string', 'ERROR_NOT_SANITIZED')
  ok(codes.includes(value.error), 'ERROR_CODE_UNEXPECTED')
  ok(response.headers.get('Cache-Control')?.includes('no-store'), 'ERROR_CACHE_CONTROL')
}

interface CreatedSession {
  sessionId: string
  emitterToken: string
  viewerCapability: string
  expiresAt: string
}

interface ViewerSession {
  sessionId: string
  viewerSessionToken: string
  viewerGeneration: number
  expiresAt: string
}

function point(sequence: number, capturedAt: Date) {
  return {
    version: 1,
    sequence,
    lat: 10.1234 + sequence * 0.00001,
    lng: 20.5678 + sequence * 0.00001,
    accuracyM: 8,
    speedMps: 1,
    headingDeg: 30,
    capturedAt: capturedAt.toISOString(),
  }
}

async function createSession(): Promise<CreatedSession> {
  const response = await request('/api/share/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: target.origin },
    body: JSON.stringify({ durationMs: 5 * 60_000 }),
  })
  if (response.status !== 201) {
    const failure = await payload<{ error?: string }>(response)
    throw new QaFailure(`SESSION_CREATE_HTTP_${response.status}_${failure.error || 'UNKNOWN'}`)
  }
  const created = await payload<CreatedSession>(response)
  ok(CAPABILITY.test(created.sessionId), 'SESSION_ID_FORMAT')
  ok(CAPABILITY.test(created.emitterToken), 'EMITTER_TOKEN_FORMAT')
  ok(VIEWER_CAPABILITY.test(created.viewerCapability), 'VIEWER_CAPABILITY_FORMAT')
  ok(Number.isFinite(Date.parse(created.expiresAt)), 'SESSION_EXPIRY_FORMAT')
  return created
}

async function publish(created: CreatedSession, sequence: number, capturedAt: Date): Promise<void> {
  const response = await request(`/api/share/sessions/${created.sessionId}/points`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Stracker-Emitter': created.emitterToken,
      Origin: target.origin,
    },
    body: JSON.stringify(point(sequence, capturedAt)),
  })
  ok(response.status === 202, `POINT_${sequence}_PUBLICATION`)
  const value = await payload<{ status?: string; point?: { sequence?: number; acceptanceState?: string } }>(response)
  ok(value.status === 'ok' && value.point?.sequence === sequence && value.point.acceptanceState === 'accepted', `POINT_${sequence}_ACCEPTANCE`)
}

async function exchange(viewerCapability: string): Promise<ViewerSession> {
  const response = await request('/api/share/viewer/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: target.origin },
    body: JSON.stringify({ viewerCapability }),
  })
  ok(response.status === 200, 'VIEWER_EXCHANGE')
  const viewer = await payload<ViewerSession>(response)
  ok(CAPABILITY.test(viewer.viewerSessionToken), 'VIEWER_SESSION_FORMAT')
  ok(Number.isFinite(Date.parse(viewer.expiresAt)), 'VIEWER_SESSION_EXPIRY_FORMAT')
  return viewer
}

async function statusRequest(sessionId: string, token: string): Promise<Response> {
  return request(`/api/share/sessions/${sessionId}/status`, {
    headers: { Authorization: `Bearer ${token}`, Origin: target.origin },
  })
}

async function pointsRequest(sessionId: string, token: string): Promise<Response> {
  return request(`/api/share/sessions/${sessionId}/points`, {
    headers: { Authorization: `Bearer ${token}`, Origin: target.origin },
  })
}

async function waitForRuntimeIdentity(): Promise<void> {
  let lastCode = 'VERSION_METADATA_UNAVAILABLE'
  for (let attempt = 1; attempt <= RUNTIME_IDENTITY_ATTEMPTS; attempt += 1) {
    const nonce = `${Date.now()}-${attempt}-${Math.random().toString(36).slice(2)}`
    const versionResponse = await request(`/__stracker/version.json?qa=api-${nonce}`)
    const version = await versionResponse.json().catch(() => null) as { sourceSha?: string; versionId?: string } | null
    if (versionResponse.status !== 200 || !version) lastCode = 'VERSION_METADATA_UNAVAILABLE'
    else if (version.sourceSha !== expectedSha) lastCode = 'VERSION_SOURCE_SHA_MISMATCH'
    else if (version.versionId !== expectedVersionId) lastCode = 'VERSION_ID_MISMATCH'
    else {
      const buildResponse = await request(`/__stracker/build.json?qa=api-${nonce}`)
      const build = await buildResponse.json().catch(() => null) as { sourceSha?: string; release?: string } | null
      if (buildResponse.status !== 200 || !build) lastCode = 'BUILD_INFO_UNAVAILABLE'
      else if (build.sourceSha !== expectedSha) lastCode = 'BUILD_SOURCE_SHA_MISMATCH'
      else if (build.release !== expectedRelease) lastCode = 'BUILD_RELEASE_MISMATCH'
      else return
    }
    if (attempt < RUNTIME_IDENTITY_ATTEMPTS) await Bun.sleep(1_000)
  }
  throw new QaFailure(lastCode)
}

const result = {
  schema: 'stracker.native-sharing-live-api-qa.v1',
  sourceSha: expectedSha,
  targetUrl: target.origin + '/',
  privateDataUsed: false,
  realCoordinatesUsed: false,
  syntheticCoordinateValuesRetained: false,
  capabilitiesRetained: false,
  authorizationValuesRetained: false,
  gates: {} as Record<string, string>,
}

let first: CreatedSession | null = null
let second: CreatedSession | null = null
try {
  await waitForRuntimeIdentity()

  first = await createSession()
  const baseTime = new Date(Date.now() - 15_000)
  await publish(first, 1, baseTime)
  const firstViewer = await exchange(first.viewerCapability)

  const firstStatus = await statusRequest(first.sessionId, firstViewer.viewerSessionToken)
  ok(firstStatus.status === 200, 'AUTHENTICATED_STATUS')
  const firstStatusPayload = await payload<{ state?: string; pointCount?: number }>(firstStatus)
  ok(firstStatusPayload.state === 'active' && firstStatusPayload.pointCount === 1, 'STATUS_CONTENT')

  const firstPoints = await pointsRequest(first.sessionId, firstViewer.viewerSessionToken)
  ok(firstPoints.status === 200, 'AUTHENTICATED_POINTS')
  const firstPointsPayload = await payload<{ state?: string; points?: Array<{ sequence?: number }> }>(firstPoints)
  ok(firstPointsPayload.state === 'active' && firstPointsPayload.points?.length === 1 && firstPointsPayload.points[0]?.sequence === 1, 'FIRST_POINT_READ')

  await publish(first, 2, new Date(baseTime.getTime() + 6_000))
  const secondPoints = await pointsRequest(first.sessionId, firstViewer.viewerSessionToken)
  ok(secondPoints.status === 200, 'SECOND_POINT_READ')
  const secondPointsPayload = await payload<{ points?: Array<{ sequence?: number }> }>(secondPoints)
  ok(secondPointsPayload.points?.map((entry) => entry.sequence).join(',') === '1,2', 'SEQUENCE_ORDER')

  const replayResponse = await request(`/api/share/sessions/${first.sessionId}/points`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Stracker-Emitter': first.emitterToken,
      Origin: target.origin,
    },
    body: JSON.stringify(point(2, new Date(baseTime.getTime() + 6_000))),
  })
  await expectError(replayResponse, [409, 422], ['REPLAY_REJECTED', 'SEQUENCE_RACE'])

  const rotateResponse = await request(`/api/share/sessions/${first.sessionId}/rotate-viewer`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Stracker-Emitter': first.emitterToken,
      Origin: target.origin,
    },
    body: '{}',
  })
  ok(rotateResponse.status === 200, 'ROTATE_VIEWER')
  const rotated = await payload<{ viewerCapability?: string; viewerGeneration?: number }>(rotateResponse)
  ok(typeof rotated.viewerCapability === 'string' && VIEWER_CAPABILITY.test(rotated.viewerCapability), 'ROTATED_CAPABILITY_FORMAT')
  ok(rotated.viewerGeneration === 2, 'ROTATED_GENERATION')

  await expectError(await statusRequest(first.sessionId, firstViewer.viewerSessionToken), [401], ['VIEWER_SESSION_INVALID'])
  await expectError(await request('/api/share/viewer/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: target.origin },
    body: JSON.stringify({ viewerCapability: first.viewerCapability }),
  }), [401, 404], ['VIEWER_SESSION_INVALID', 'NOT_FOUND'])

  const replacement = await exchange(rotated.viewerCapability)
  second = await createSession()
  await expectError(await statusRequest(second.sessionId, replacement.viewerSessionToken), [401, 404], ['VIEWER_SESSION_INVALID', 'NOT_FOUND'])

  const logoutResponse = await request('/api/share/viewer/logout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${replacement.viewerSessionToken}`,
      Origin: target.origin,
    },
    body: JSON.stringify({ sessionId: first.sessionId }),
  })
  ok(logoutResponse.status === 200, 'VIEWER_LOGOUT')
  await expectError(await statusRequest(first.sessionId, replacement.viewerSessionToken), [401], ['VIEWER_SESSION_INVALID'])

  const revokeResponse = await request(`/api/share/sessions/${first.sessionId}`, {
    method: 'DELETE',
    headers: { 'X-Stracker-Emitter': first.emitterToken, Origin: target.origin },
  })
  ok(revokeResponse.status === 200, 'SESSION_REVOCATION')
  await expectError(await pointsRequest(first.sessionId, replacement.viewerSessionToken), [401, 410], ['SESSION_REVOKED', 'VIEWER_SESSION_INVALID'])
  await expectError(await request(`/api/share/sessions/${first.sessionId}/points`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Stracker-Emitter': first.emitterToken,
      Origin: target.origin,
    },
    body: JSON.stringify(point(3, new Date(baseTime.getTime() + 12_000))),
  }), [410], ['SESSION_REVOKED'])

  const cleanupSecond = await request(`/api/share/sessions/${second.sessionId}`, {
    method: 'DELETE',
    headers: { 'X-Stracker-Emitter': second.emitterToken, Origin: target.origin },
  })
  ok(cleanupSecond.status === 200, 'SECOND_SESSION_CLEANUP')

  result.gates = {
    VERSION_METADATA_MATCH: 'PASS',
    BUILD_ASSET_SHA_MATCH: 'PASS',
    SESSION_CREATE: 'PASS',
    FIRST_CONFIRMED_POINT_PUBLICATION: 'PASS',
    VIEWER_ONE_TIME_EXCHANGE: 'PASS',
    AUTHENTICATED_STATUS_AND_POINTS: 'PASS',
    SECOND_POINT_UPDATE: 'PASS',
    SEQUENCE_ORDER: 'PASS',
    SEQUENCE_REPLAY_REJECTED: 'PASS',
    ROTATE_VIEWER: 'PASS',
    OLD_CAPABILITY_REJECTED: 'PASS',
    OLD_VIEWER_SESSION_REJECTED: 'PASS',
    NEW_CAPABILITY_ACCEPTED: 'PASS',
    VIEWER_LOGOUT_INVALIDATION: 'PASS',
    SESSION_REVOCATION: 'PASS',
    POST_REVOCATION_READ_REJECTED: 'PASS',
    POST_REVOCATION_WRITE_REJECTED: 'PASS',
    CROSS_SESSION_ISOLATION: 'PASS',
  }
  await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
  console.log(`LIVE_NATIVE_SHARING_API_QA=PASS sha=${expectedSha}`)
} catch (error) {
  console.error(`LIVE_NATIVE_SHARING_API_QA=FAIL code=${error instanceof QaFailure ? error.code : 'UNEXPECTED'}`)
  throw error
}
