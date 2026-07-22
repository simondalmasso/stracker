import { validateAccessJwt } from '../../gateway/src/access-jwt.mjs'
import type { AccessIdentity, ParsedSession, SessionPublicStatus, SessionStore } from './contracts'
import { decryptSession, encryptSession, hashIdentitySubject } from './crypto'
import {
  MAX_IMPORT_BYTES,
  SessionInputError,
  parseCookieInput,
  probeGoogleMapsSession,
  unconfiguredStatus,
} from './session'
import { createD1SessionStore, type D1DatabaseLike } from './storage'

const GATEWAY_MARKER = 'private-poc-v1'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

interface AssetBinding {
  fetch(request: Request): Promise<Response>
}

interface RuntimeEnv {
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD: string
  SESSION_ENCRYPTION_KEY: string
  SESSION_DB: D1DatabaseLike
  ASSETS?: AssetBinding
  STRACKER_SERVICE_TOKEN?: string
}

interface RuntimeDependencies {
  validateIdentity?: (assertion: string | null, env: RuntimeEnv) => Promise<AccessIdentity>
  fetchGoogle?: typeof fetch
  storeFactory?: (env: RuntimeEnv) => SessionStore
  now?: () => Date
}

function responseHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Stracker-Gateway': GATEWAY_MARKER,
    ...extra,
  })
}

function json(status: number, payload: unknown, extra: Record<string, string> = {}): Response {
  const body = JSON.stringify(payload)
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    return new Response(JSON.stringify({ status: 'error', error: 'RESPONSE_TOO_LARGE', message: 'Response exceeded the runtime limit.' }), {
      status: 502,
      headers: responseHeaders(),
    })
  }
  return new Response(body, { status, headers: responseHeaders(extra) })
}

function fail(status: number, error: string, message: string): Response {
  return json(status, { status: 'error', error, message })
}

function required(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function defaultValidateIdentity(assertion: string | null, env: RuntimeEnv): Promise<AccessIdentity> {
  const teamDomain = required(env.ACCESS_TEAM_DOMAIN)
  const audience = required(env.ACCESS_AUD)
  if (!teamDomain || !audience) throw Object.assign(new Error('Cloudflare Access bindings are incomplete.'), { code: 'ACCESS_NOT_CONFIGURED' })
  const claims = await validateAccessJwt(assertion, { teamDomain, audience, fetchImpl: fetch })
  if (!claims || typeof claims.sub !== 'string' || !claims.sub.trim()) {
    throw Object.assign(new Error('Cloudflare Access subject is missing.'), { code: 'ACCESS_SUBJECT_MISSING' })
  }
  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : undefined,
    exp: typeof claims.exp === 'number' ? claims.exp : undefined,
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get('content-length') || '0')
  if (Number.isFinite(length) && length > MAX_IMPORT_BYTES) throw new SessionInputError('INPUT_TOO_LARGE', 'La sesión supera el tamaño permitido.', 'Exportá únicamente las cookies necesarias de Google Maps.')
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    throw new SessionInputError('CONTENT_TYPE_REJECTED', 'Content-Type debe ser application/json.', 'Enviá un cuerpo JSON válido.')
  }
  const body = await request.arrayBuffer()
  if (!body.byteLength) throw new SessionInputError('EMPTY_INPUT', 'No se recibió contenido.', 'Enviá un cuerpo JSON válido.')
  if (body.byteLength > MAX_IMPORT_BYTES) throw new SessionInputError('INPUT_TOO_LARGE', 'La sesión supera el tamaño permitido.', 'Exportá únicamente las cookies necesarias de Google Maps.')
  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new SessionInputError('INVALID_JSON', 'El cuerpo JSON no es válido.', 'Corregí el contenido e intentá nuevamente.')
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new SessionInputError('INVALID_BODY', 'El cuerpo debe ser un objeto JSON.', 'Enviá un objeto con el campo raw.')
  return decoded as Record<string, unknown>
}

function statusCodeForStatus(status: SessionPublicStatus): number {
  if (status.health === 'EXPIRED' || status.health === 'INVALID') return 401
  if (status.health === 'UPSTREAM_UNAVAILABLE' || status.health === 'UNSUPPORTED_RESPONSE') return 502
  if (status.health === 'INCOMPLETE') return 422
  return 200
}

function serializeSession(parsed: ParsedSession): string {
  return JSON.stringify({
    formatDetected: parsed.formatDetected,
    cookies: parsed.cookies,
    criticalPresent: parsed.criticalPresent,
    criticalMissing: parsed.criticalMissing,
  })
}

function deserializeSession(raw: string): ParsedSession {
  const decoded = JSON.parse(raw) as ParsedSession
  if (!decoded || !Array.isArray(decoded.cookies) || !Array.isArray(decoded.criticalPresent) || !Array.isArray(decoded.criticalMissing)) {
    throw new Error('STORED_SESSION_INVALID')
  }
  return decoded
}

export function createRuntime(dependencies: RuntimeDependencies = {}) {
  const validateIdentity = dependencies.validateIdentity ?? defaultValidateIdentity
  const fetchGoogle = dependencies.fetchGoogle ?? fetch
  const storeFactory = dependencies.storeFactory ?? ((env: RuntimeEnv) => createD1SessionStore(env.SESSION_DB))
  const now = dependencies.now ?? (() => new Date())

  return {
    async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
      const url = new URL(request.url)
      const isApi = url.pathname === '/points' || url.pathname.startsWith('/api/')
      if (!isApi) {
        if (!env?.ASSETS) return fail(503, 'STATIC_ASSETS_NOT_CONFIGURED', 'Static assets binding is unavailable.')
        return env.ASSETS.fetch(request)
      }
      if (url.search || url.hash) return fail(400, 'QUERY_NOT_ALLOWED', 'Query parameters are not accepted.')

      let identity: AccessIdentity
      try {
        identity = await validateIdentity(request.headers.get('cf-access-jwt-assertion'), env)
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'ACCESS_JWT_INVALID'
        return fail(403, code, 'Cloudflare Access authorization is required.')
      }

      const encryptionKey = required(env?.SESSION_ENCRYPTION_KEY)
      if (!encryptionKey || encryptionKey.length < 32 || !env?.SESSION_DB) {
        return fail(503, 'RUNTIME_NOT_CONFIGURED', 'Shared-session storage or encryption is unavailable.')
      }
      const store = storeFactory(env)
      const subjectHash = await hashIdentitySubject(identity.sub)

      if (request.method === 'GET' && url.pathname === '/api/session/status') {
        const record = await store.get(subjectHash)
        if (!record) return json(200, unconfiguredStatus())
        try {
          const parsed = deserializeSession(await decryptSession(record.ivB64, record.ciphertextB64, encryptionKey, subjectHash))
          const result = await probeGoogleMapsSession(parsed, fetchGoogle, now().toISOString())
          return json(200, result.status)
        } catch {
          return fail(503, 'SESSION_DECRYPTION_FAILED', 'La sesión vinculada no pudo abrirse de forma segura.')
        }
      }

      if (request.method === 'POST' && url.pathname === '/api/session/import') {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(request)
        } catch (error) {
          if (error instanceof SessionInputError) return json(400, { status: 'error', error: error.code, message: error.message, action: error.action })
          return fail(400, 'INVALID_REQUEST', 'La solicitud no es válida.')
        }
        if (typeof body.raw !== 'string') return fail(400, 'RAW_SESSION_REQUIRED', 'El campo raw es obligatorio.')
        let parsed: ParsedSession
        try {
          parsed = parseCookieInput(body.raw, now().getTime())
        } catch (error) {
          if (error instanceof SessionInputError) return json(400, { status: 'error', error: error.code, message: error.message, action: error.action })
          return fail(400, 'SESSION_PARSE_FAILED', 'La sesión no pudo interpretarse.')
        }
        const probe = await probeGoogleMapsSession(parsed, fetchGoogle, now().toISOString())
        if (!probe.status.configured) {
          return json(statusCodeForStatus(probe.status), { status: 'error', action: 'Renová o revisá la sesión.', ...probe.status })
        }
        const encrypted = await encryptSession(serializeSession(parsed), encryptionKey, subjectHash)
        const timestamp = now().toISOString()
        const previous = await store.get(subjectHash)
        await store.put({
          subjectHash,
          ivB64: encrypted.ivB64,
          ciphertextB64: encrypted.ciphertextB64,
          createdAt: previous?.createdAt ?? timestamp,
          updatedAt: timestamp,
        })
        return json(200, { status: 'ok', action: 'La sesión quedó vinculada.', ...probe.status })
      }

      if (request.method === 'POST' && url.pathname === '/api/session/delete') {
        await store.delete(subjectHash)
        return json(200, { status: 'ok' })
      }

      if (request.method === 'GET' && url.pathname === '/points') {
        const record = await store.get(subjectHash)
        if (!record) return fail(409, 'SHARED_SESSION_REQUIRED', 'Vinculá una sesión autorizada de Google Maps antes de abrir la ubicación compartida.')
        let parsed: ParsedSession
        try {
          parsed = deserializeSession(await decryptSession(record.ivB64, record.ciphertextB64, encryptionKey, subjectHash))
        } catch {
          return fail(503, 'SESSION_DECRYPTION_FAILED', 'La sesión vinculada no pudo abrirse de forma segura.')
        }
        const probe = await probeGoogleMapsSession(parsed, fetchGoogle, now().toISOString())
        const statusCode = statusCodeForStatus(probe.status)
        if (statusCode !== 200) return json(statusCode, { status: 'error', error: probe.status.health, message: probe.status.message })
        return json(200, {
          points: probe.point ? [probe.point] : [],
          ghostrail_pts: [],
          last_update: probe.point?.timestamp ?? null,
          state: {
            source: 'google-shared',
            sharedSession: probe.status.configured ? 'valid' : 'unconfigured',
            identityAuthenticated: true,
          },
        })
      }

      if (['GET', 'POST'].includes(request.method)) return fail(404, 'ROUTE_NOT_ALLOWED', 'Route is not exposed by this runtime.')
      return json(405, { status: 'error', error: 'METHOD_NOT_ALLOWED', message: 'Method is not allowed.' }, { Allow: 'GET, POST' })
    },
  }
}

export default createRuntime()
