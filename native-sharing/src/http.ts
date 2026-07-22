import type { NativeSharedLocationPoint } from './contracts.js'
import {
  MAX_CREATE_REQUESTS_PER_MINUTE,
  MAX_EMITTER_REQUESTS_PER_MINUTE,
  MAX_REQUEST_BODY_BYTES,
  MAX_VIEWER_REQUESTS_PER_MINUTE,
  STORE_TIMEOUT_MS,
} from './limits.js'
import { PointValidationError } from './geo.js'
import { NativeSharingError, NativeSharingService } from './service.js'

interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): boolean
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, number[]>()
  consume(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now()
    const active = (this.buckets.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs)
    if (active.length >= limit) {
      this.buckets.set(key, active)
      return false
    }
    active.push(now)
    this.buckets.set(key, active)
    return true
  }
}

function headers(extra: Record<string, string> = {}): Headers {
  return new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  })
}

function json(status: number, payload: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: headers(extra) })
}

function clientKey(request: Request): string {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) throw new NativeSharingError(415, 'CONTENT_TYPE_REJECTED', 'Content-Type must be application/json.')
  const declared = Number(request.headers.get('content-length') || '0')
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) throw new NativeSharingError(413, 'REQUEST_TOO_LARGE', 'Request body is too large.')
  const body = await request.arrayBuffer()
  if (!body.byteLength) throw new NativeSharingError(400, 'BODY_REQUIRED', 'JSON body is required.')
  if (body.byteLength > MAX_REQUEST_BODY_BYTES) throw new NativeSharingError(413, 'REQUEST_TOO_LARGE', 'Request body is too large.')
  try {
    const decoded = JSON.parse(new TextDecoder().decode(body))
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('object required')
    return decoded as Record<string, unknown>
  } catch {
    throw new NativeSharingError(400, 'INVALID_JSON', 'Request body must contain a JSON object.')
  }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new NativeSharingError(504, 'STORE_TIMEOUT', 'Storage operation timed out.')), STORE_TIMEOUT_MS) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createNativeSharingHttp(service: NativeSharingService, limiter: RateLimiter = new InMemoryRateLimiter()) {
  return {
    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url)
        if (url.search || url.hash) throw new NativeSharingError(400, 'QUERY_NOT_ALLOWED', 'Query parameters are not accepted.')
        const origin = request.headers.get('origin')
        if (origin && origin !== url.origin) throw new NativeSharingError(403, 'CROSS_ORIGIN_REJECTED', 'Cross-origin requests are not accepted.')
        if (request.method === 'OPTIONS') return json(405, { status: 'error', error: 'METHOD_NOT_ALLOWED', message: 'Method is not allowed.' }, { Allow: 'GET, POST, DELETE' })

        if (request.method === 'POST' && url.pathname === '/api/share/sessions') {
          if (!limiter.consume(`create:${clientKey(request)}`, MAX_CREATE_REQUESTS_PER_MINUTE, 60_000)) throw new NativeSharingError(429, 'RATE_LIMITED', 'Too many session creation requests.')
          const body = await readJson(request)
          const durationMs = typeof body.durationMs === 'number' ? body.durationMs : undefined
          return json(201, await bounded(service.createSession(durationMs)))
        }

        const match = /^\/api\/share\/sessions\/([A-Za-z0-9_-]{43})(?:\/(points|status|rotate-viewer))?$/.exec(url.pathname)
        if (!match) throw new NativeSharingError(404, 'NOT_FOUND', 'Resource was not found.')
        const [, sessionId, action] = match

        if (request.method === 'POST' && action === 'points') {
          const emitter = request.headers.get('x-stracker-emitter') || ''
          if (!limiter.consume(`emit:${sessionId}`, MAX_EMITTER_REQUESTS_PER_MINUTE, 60_000)) throw new NativeSharingError(429, 'RATE_LIMITED', 'Emitter rate limit reached.')
          const body = await readJson(request)
          return json(202, { status: 'ok', point: await bounded(service.appendPoint(sessionId, emitter, body as unknown as NativeSharedLocationPoint)) })
        }
        if (request.method === 'GET' && action === 'status') {
          const viewer = request.headers.get('x-stracker-viewer') || ''
          if (!limiter.consume(`view:${sessionId}`, MAX_VIEWER_REQUESTS_PER_MINUTE, 60_000)) throw new NativeSharingError(429, 'RATE_LIMITED', 'Viewer rate limit reached.')
          return json(200, await bounded(service.getStatus(sessionId, viewer)))
        }
        if (request.method === 'GET' && action === 'points') {
          const viewer = request.headers.get('x-stracker-viewer') || ''
          if (!limiter.consume(`view:${sessionId}`, MAX_VIEWER_REQUESTS_PER_MINUTE, 60_000)) throw new NativeSharingError(429, 'RATE_LIMITED', 'Viewer rate limit reached.')
          return json(200, await bounded(service.getPoints(sessionId, viewer)))
        }
        if (request.method === 'POST' && action === 'rotate-viewer') {
          const emitter = request.headers.get('x-stracker-emitter') || ''
          return json(200, await bounded(service.rotateViewer(sessionId, emitter)))
        }
        if (request.method === 'DELETE' && action === undefined) {
          const emitter = request.headers.get('x-stracker-emitter') || ''
          await bounded(service.revoke(sessionId, emitter))
          return json(200, { status: 'ok', state: 'revoked' })
        }

        throw new NativeSharingError(405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.')
      } catch (error) {
        if (error instanceof NativeSharingError) return json(error.status, { status: 'error', error: error.code, message: error.message })
        if (error instanceof PointValidationError) return json(422, { status: 'error', error: error.code, message: 'Point was rejected by server validation.' })
        return json(500, { status: 'error', error: 'INTERNAL_ERROR', message: 'The request could not be completed.' })
      }
    },
  }
}
