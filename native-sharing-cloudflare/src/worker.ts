import type {
  CreateSessionResponse,
  NativeSharedLocationPoint,
  NativeSharingSession,
} from '../../native-sharing/src/contracts.js'
import {
  buildViewerCapability,
  capabilityVerifier,
  generateCapability,
  parseViewerCapability,
} from '../../native-sharing/src/security.js'
import {
  DEFAULT_COOKIE_SESSION_DURATION_MS,
  MAX_COOKIE_INPUT_BYTES,
  MAX_COOKIE_SESSION_DURATION_MS,
  MIN_COOKIE_SESSION_DURATION_MS,
  type CookieSessionCreateResponse,
} from './cookie-session.js'
import {
  DEFAULT_SESSION_DURATION_MS,
  MAX_CREATE_ATTEMPTS,
  MAX_REQUEST_BODY_BYTES,
  MAX_SESSION_DURATION_MS,
  MIN_SESSION_DURATION_MS,
  RPC_TIMEOUT_MS,
} from './runtime-limits.js'
import type {
  NativeSharingRpcStub,
  NativeSharingRuntimeBindings,
  RpcResult,
  RuntimeCookieSessionRequest,
  RuntimeCreateSessionRequest,
  RuntimeErrorCode,
  RuntimeViewerExchangeRequest,
  RuntimeViewerLogoutRequest,
} from './runtime-contracts.js'

const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const API_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Content-Type': 'application/json; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const

class HttpBoundaryError extends Error {
  constructor(readonly status: number, readonly code: RuntimeErrorCode) {
    super(code)
    this.name = 'HttpBoundaryError'
  }
}

function response(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: API_HEADERS })
}

function errorResponse(status: number, code: RuntimeErrorCode): Response {
  return response(status, { status: 'error', error: code })
}

function success<T>(value: T, status = 200): Response {
  return response(status, value)
}

function unwrap<T>(result: RpcResult<T>, status = 200): Response {
  return result.ok ? success(result.value, status) : errorResponse(result.status, result.code)
}

function ensureSameOrigin(request: Request, url: URL): void {
  const origin = request.headers.get('Origin')
  if (origin && origin !== url.origin) throw new HttpBoundaryError(403, 'ORIGIN_REJECTED')
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new HttpBoundaryError(403, 'ORIGIN_REJECTED')
}

async function readBoundedJsonBody<T>(request: Request, maxBytes: number): Promise<T> {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') throw new HttpBoundaryError(415, 'CONTENT_TYPE_REQUIRED')
  const length = request.headers.get('Content-Length')
  if (length && Number(length) > maxBytes) throw new HttpBoundaryError(413, 'BODY_TOO_LARGE')
  if (!request.body) return {} as T

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new HttpBoundaryError(413, 'BODY_TOO_LARGE')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T
  } catch {
    throw new HttpBoundaryError(400, 'REQUEST_INVALID')
  }
}

function boundedDuration(value: unknown): number {
  if (value === undefined) return DEFAULT_SESSION_DURATION_MS
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpBoundaryError(400, 'REQUEST_INVALID')
  const duration = Math.floor(value)
  if (duration < MIN_SESSION_DURATION_MS || duration > MAX_SESSION_DURATION_MS) throw new HttpBoundaryError(400, 'REQUEST_INVALID')
  return duration
}

function boundedCookieDuration(value: unknown): number {
  if (value === undefined) return DEFAULT_COOKIE_SESSION_DURATION_MS
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpBoundaryError(400, 'REQUEST_INVALID')
  const duration = Math.floor(value)
  if (duration < MIN_COOKIE_SESSION_DURATION_MS || duration > MAX_COOKIE_SESSION_DURATION_MS) throw new HttpBoundaryError(400, 'REQUEST_INVALID')
  return duration
}

function bearer(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') ?? '')
  if (!match) throw new HttpBoundaryError(404, 'NOT_FOUND')
  return match[1]
}

function emitter(request: Request): string {
  const value = request.headers.get('X-Stracker-Emitter') ?? ''
  if (!TOKEN_PATTERN.test(value)) throw new HttpBoundaryError(404, 'NOT_FOUND')
  return value
}

function cookieOwner(request: Request): string {
  const value = request.headers.get('X-Stracker-Cookie-Owner') ?? ''
  if (!TOKEN_PATTERN.test(value)) throw new HttpBoundaryError(404, 'NOT_FOUND')
  return value
}

function cookieScope(request: Request, sessionId: string): string {
  const value = request.headers.get('X-Stracker-Mobility-Scope') || sessionId
  if (!TOKEN_PATTERN.test(value)) throw new HttpBoundaryError(404, 'NOT_FOUND')
  return value
}

function namespace(env: NativeSharingRuntimeBindings) {
  if (!env.NATIVE_SHARING || typeof env.NATIVE_SHARING.getByName !== 'function') {
    throw new HttpBoundaryError(503, 'BINDING_UNAVAILABLE')
  }
  return env.NATIVE_SHARING
}

function stubFor(env: NativeSharingRuntimeBindings, objectName: string): NativeSharingRpcStub {
  if (!SESSION_PATTERN.test(objectName)) throw new HttpBoundaryError(404, 'NOT_FOUND')
  return namespace(env).getByName(objectName)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new HttpBoundaryError(504, 'OPERATION_TIMEOUT')), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function createSession(request: Request, env: NativeSharingRuntimeBindings): Promise<Response> {
  const body = await readBoundedJsonBody<RuntimeCreateSessionRequest>(request, MAX_REQUEST_BODY_BYTES)
  const duration = boundedDuration(body.durationMs)
  const createdAt = new Date()
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
    const sessionId = generateCapability()
    const emitterToken = generateCapability()
    const viewerToken = generateCapability()
    const session: NativeSharingSession = {
      id: sessionId,
      emitterVerifier: await capabilityVerifier(emitterToken),
      viewerVerifier: await capabilityVerifier(viewerToken),
      viewerGeneration: 1,
      state: 'active',
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + duration).toISOString(),
      revokedAt: null,
      lastSequence: 0,
      lastCapturedAt: null,
      lastReceivedAt: null,
      pointCount: 0,
    }
    const result = await withTimeout(stubFor(env, sessionId).createSession({ session }))
    if (!result.ok && result.code === 'SESSION_COLLISION') continue
    if (!result.ok) return errorResponse(result.status, result.code)
    const payload: CreateSessionResponse = {
      sessionId,
      emitterToken,
      viewerCapability: buildViewerCapability(sessionId, viewerToken),
      expiresAt: session.expiresAt,
    }
    return success(payload, 201)
  }
  return errorResponse(503, 'CAPABILITY_GENERATION_FAILED')
}

async function createCookieSession(request: Request, env: NativeSharingRuntimeBindings): Promise<Response> {
  const body = await readBoundedJsonBody<RuntimeCookieSessionRequest>(request, MAX_COOKIE_INPUT_BYTES + 4096)
  if (typeof body.raw !== 'string') throw new HttpBoundaryError(400, 'REQUEST_INVALID')
  if (body.mobilityScope !== undefined && !TOKEN_PATTERN.test(body.mobilityScope)) throw new HttpBoundaryError(400, 'REQUEST_INVALID')
  const sessionId = generateCapability()
  const ownerToken = generateCapability()
  const mobilityScope = body.mobilityScope || sessionId
  const result = await withTimeout(stubFor(env, mobilityScope).importCookieSession({
    sessionId,
    ownerVerifier: await capabilityVerifier(ownerToken),
    raw: body.raw,
    durationMs: boundedCookieDuration(body.durationMs),
  }), 12_000)
  if (!result.ok) return errorResponse(result.status, result.code)
  const payload: CookieSessionCreateResponse = {
    status: 'ok',
    sessionId,
    ownerToken,
    mobilityScope,
    storagePolicy: 'encrypted-durable',
    ...result.value,
  }
  return success(payload, 201)
}

function historySince(url: URL): string {
  if (url.searchParams.size !== 1 || url.searchParams.getAll('since').length !== 1) throw new HttpBoundaryError(400, 'REQUEST_INVALID')
  const since = url.searchParams.get('since') || ''
  if (!Number.isFinite(Date.parse(since))) throw new HttpBoundaryError(400, 'REQUEST_INVALID')
  return since
}

async function routeCookieApi(request: Request, env: NativeSharingRuntimeBindings, url: URL): Promise<Response> {
  ensureSameOrigin(request, url)
  if (url.pathname === '/api/cookie-sessions') {
    if (url.search) throw new HttpBoundaryError(400, 'REQUEST_INVALID')
    if (request.method !== 'POST') throw new HttpBoundaryError(405, 'METHOD_NOT_ALLOWED')
    return createCookieSession(request, env)
  }
  const match = /^\/api\/cookie-sessions\/([A-Za-z0-9_-]{43})(?:\/(status|point|history|refresh|mobility-memory))?$/.exec(url.pathname)
  if (!match) throw new HttpBoundaryError(404, 'NOT_FOUND')
  const sessionId = match[1]
  const operation = match[2] ?? 'session'
  if (operation !== 'history' && url.search) throw new HttpBoundaryError(400, 'REQUEST_INVALID')
  const ownerToken = cookieOwner(request)
  const stub = stubFor(env, cookieScope(request, sessionId))
  if (operation === 'status' && request.method === 'GET') return unwrap(await withTimeout(stub.getCookieSessionStatus(sessionId, ownerToken)))
  if (operation === 'point' && request.method === 'GET') return unwrap(await withTimeout(stub.getCookieSessionPoint(sessionId, ownerToken)))
  if (operation === 'history' && request.method === 'GET') return unwrap(await withTimeout(stub.getCookieSessionHistory(sessionId, ownerToken, historySince(url)), 12_000))
  if (operation === 'refresh' && request.method === 'POST') return unwrap(await withTimeout(stub.refreshCookieSession(sessionId, ownerToken), 12_000))
  if (operation === 'mobility-memory' && request.method === 'DELETE') {
    const result = await withTimeout(stub.clearCookieMobility(sessionId, ownerToken))
    return result.ok ? success({ status: 'ok', state: 'cleared' }) : errorResponse(result.status, result.code)
  }
  if (operation === 'session' && request.method === 'DELETE') {
    const result = await withTimeout(stub.deleteCookieSession(sessionId, ownerToken))
    return result.ok ? success({ status: 'ok', state: 'revoked' }) : errorResponse(result.status, result.code)
  }
  throw new HttpBoundaryError(405, 'METHOD_NOT_ALLOWED')
}

async function routeNativeApi(request: Request, env: NativeSharingRuntimeBindings, url: URL): Promise<Response> {
  if (url.search) throw new HttpBoundaryError(400, 'REQUEST_INVALID')
  ensureSameOrigin(request, url)

  if (url.pathname === '/api/share/sessions') {
    if (request.method !== 'POST') throw new HttpBoundaryError(405, 'METHOD_NOT_ALLOWED')
    return createSession(request, env)
  }

  if (url.pathname === '/api/share/viewer/exchange') {
    if (request.method !== 'POST') throw new HttpBoundaryError(405, 'METHOD_NOT_ALLOWED')
    const body = await readBoundedJsonBody<RuntimeViewerExchangeRequest>(request, MAX_REQUEST_BODY_BYTES)
    if (typeof body.viewerCapability !== 'string') throw new HttpBoundaryError(400, 'REQUEST_INVALID')
    const parsed = parseViewerCapability(body.viewerCapability)
    if (!parsed) throw new HttpBoundaryError(404, 'NOT_FOUND')
    return unwrap(await withTimeout(stubFor(env, parsed.sessionId).exchangeViewerCapability(body.viewerCapability)))
  }

  if (url.pathname === '/api/share/viewer/logout') {
    if (request.method !== 'POST') throw new HttpBoundaryError(405, 'METHOD_NOT_ALLOWED')
    const token = bearer(request)
    const body = await readBoundedJsonBody<RuntimeViewerLogoutRequest>(request, MAX_REQUEST_BODY_BYTES)
    if (typeof body.sessionId !== 'string') throw new HttpBoundaryError(400, 'REQUEST_INVALID')
    const result = await withTimeout(stubFor(env, body.sessionId).logoutViewer(body.sessionId, token))
    return result.ok ? success({ status: 'ok' }) : errorResponse(result.status, result.code)
  }

  const match = /^\/api\/share\/sessions\/([A-Za-z0-9_-]{43})(?:\/(points|status|rotate-viewer))?$/.exec(url.pathname)
  if (!match) throw new HttpBoundaryError(404, 'NOT_FOUND')
  const sessionId = match[1]
  const operation = match[2] ?? 'session'
  const stub = stubFor(env, sessionId)

  if (operation === 'points' && request.method === 'POST') {
    const token = emitter(request)
    const point = await readBoundedJsonBody<NativeSharedLocationPoint>(request, MAX_REQUEST_BODY_BYTES)
    const result = await withTimeout(stub.appendPoint(sessionId, token, point))
    return result.ok ? success({ status: 'ok', point: result.value }, 202) : errorResponse(result.status, result.code)
  }
  if (operation === 'points' && request.method === 'GET') return unwrap(await withTimeout(stub.getPoints(sessionId, bearer(request))))
  if (operation === 'status' && request.method === 'GET') return unwrap(await withTimeout(stub.getStatus(sessionId, bearer(request))))
  if (operation === 'rotate-viewer' && request.method === 'POST') return unwrap(await withTimeout(stub.rotateViewer(sessionId, emitter(request))))
  if (operation === 'session' && request.method === 'DELETE') {
    const result = await withTimeout(stub.revoke(sessionId, emitter(request)))
    return result.ok ? success({ status: 'ok', state: 'revoked' }) : errorResponse(result.status, result.code)
  }
  throw new HttpBoundaryError(405, 'METHOD_NOT_ALLOWED')
}

export async function handleNativeSharingRequest(request: Request, env: NativeSharingRuntimeBindings): Promise<Response> {
  const url = new URL(request.url)
  try {
    if (url.pathname.startsWith('/api/cookie-sessions')) return await routeCookieApi(request, env, url)
    if (url.pathname.startsWith('/api/share/')) return await routeNativeApi(request, env, url)
    if ((url.pathname === '/shared' || url.pathname === '/shared/') && url.search) return errorResponse(400, 'REQUEST_INVALID')
    if (!env.ASSETS) return errorResponse(503, 'BINDING_UNAVAILABLE')
    return await env.ASSETS.fetch(request)
  } catch (error) {
    if (error instanceof HttpBoundaryError) return errorResponse(error.status, error.code)
    return errorResponse(503, 'STORAGE_UNAVAILABLE')
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleNativeSharingRequest(request, env)
  },
} satisfies ExportedHandler<Env>
