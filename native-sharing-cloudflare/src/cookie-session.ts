import { capabilityVerifier } from '../../native-sharing/src/security.js'
import type { RpcResult, RuntimeErrorCode } from './runtime-contracts.js'

export const COOKIE_POLICY_VERSION = 'google-maps-cookie-encrypted-do-v3'
export const MAX_COOKIE_INPUT_BYTES = 64 * 1024
export const DEFAULT_COOKIE_SESSION_DURATION_MS = 60 * 60 * 1000
export const MIN_COOKIE_SESSION_DURATION_MS = 5 * 60 * 1000
export const MAX_COOKIE_SESSION_DURATION_MS = 4 * 60 * 60 * 1000
export const COOKIE_REFRESH_MIN_INTERVAL_MS = 10_000
export const COOKIE_SESSION_STORAGE_KEY = 'stracker:cookie-session:v3'
const PROVIDER_TIMEOUT_MS = 8_000
const PROVIDER_URL = 'https://www.google.com/maps/rpc/locationsharing/read?authuser=0&hl=es&gl=ar&pb='
const AUTH_COOKIE_NAMES = new Set(['SID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'])
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const GOOGLE_DOMAIN = /^(?:[a-z0-9-]+\.)*google\.com$/i
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const ENCRYPTION_CONTEXT = 'stracker-cookie-session-v3'

export type CookieFormat = 'COOKIE_EDITOR_JSON' | 'WRAPPED_JSON' | 'COOKIE_HEADER_STRING' | 'NETSCAPE' | 'JSON_NAME_VALUE_MAP'
export type CookieProviderState = 'ready' | 'no_location'

export interface CookiePoint {
  lat: number
  lng: number
  accuracyM: number | null
  capturedAt: string
}

interface NormalizedCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  expiresAt: number | null
}

export interface ParsedCookieSession {
  cookies: NormalizedCookie[]
  format: CookieFormat
  expiresAt: number | null
  totalParsed: number
  expiredDropped: number
  retainedCount: number
}

export interface CookieSessionImportInput {
  sessionId: string
  ownerToken: string
  raw: string
  durationMs: number
}

export interface CookieSessionPublicStatus {
  state: CookieProviderState
  policyVersion: string
  format: CookieFormat
  cookieCount: number
  totalParsed: number
  expiredDropped: number
  retainedCount: number
  expiresAt: string
  validatedAt: string
  locationAvailable: boolean
}

export interface CookieSessionPointResponse {
  state: CookieProviderState
  point: CookiePoint | null
  validatedAt: string
}

export interface CookieSessionCreateResponse extends CookieSessionPublicStatus {
  status: 'ok'
  sessionId: string
  ownerToken: string
  storagePolicy: 'encrypted-durable-object'
}

export type CookieProbeResult =
  | { ok: true; state: CookieProviderState; point: CookiePoint | null }
  | { ok: false; status: number; code: RuntimeErrorCode }

export type CookieProbe = (cookies: readonly NormalizedCookie[]) => Promise<CookieProbeResult>

export interface CookieSessionStorage {
  get<T = unknown>(key: string): Promise<T | undefined>
  put<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
}

interface EncryptedCookiePayload {
  cookies: NormalizedCookie[]
  point: CookiePoint | null
}

interface PersistedCookieSession {
  version: 3
  sessionId: string
  ownerVerifier: string
  format: CookieFormat
  cookieCount: number
  totalParsed: number
  expiredDropped: number
  retainedCount: number
  expiresAtMs: number
  validatedAt: string
  state: CookieProviderState
  locationAvailable: boolean
  lastProbeAtMs: number
  iv: ArrayBuffer
  ciphertext: ArrayBuffer
}

class CookieContractError extends Error {
  constructor(readonly status: number, readonly code: RuntimeErrorCode) {
    super(code)
  }
}

function normalizedDomain(value: unknown): string {
  const domain = String(value ?? 'google.com').trim().toLowerCase().replace(/^\./, '')
  if (!GOOGLE_DOMAIN.test(domain)) throw new CookieContractError(400, 'COOKIE_DOMAIN_REJECTED')
  return `.${domain}`
}

function normalizedExpiry(value: unknown): number | null {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0' || value === -1 || value === '-1') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) throw new CookieContractError(400, 'COOKIE_INVALID')
  return numeric > 10_000_000_000 ? numeric : numeric * 1000
}

function normalizeCookie(value: unknown): NormalizedCookie {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CookieContractError(400, 'COOKIE_INVALID')
  const row = value as Record<string, unknown>
  const name = String(row.name ?? '').trim()
  if (!name || !COOKIE_NAME.test(name)) throw new CookieContractError(400, 'COOKIE_INVALID')
  const rawValue = row.value
  if (rawValue === undefined || rawValue === null || typeof rawValue === 'object') throw new CookieContractError(400, 'COOKIE_INVALID')
  return {
    name,
    value: String(rawValue),
    domain: normalizedDomain(row.domain),
    path: typeof row.path === 'string' && row.path.startsWith('/') ? row.path : '/',
    secure: row.secure === undefined ? true : Boolean(row.secure),
    httpOnly: Boolean(row.httpOnly ?? row.http_only),
    expiresAt: normalizedExpiry(row.expirationDate ?? row.expires ?? row.expiry),
  }
}

function parseJsonValue(value: unknown, wrapped = false): { rows: unknown[]; format: CookieFormat } {
  if (Array.isArray(value)) return { rows: value, format: wrapped ? 'WRAPPED_JSON' : 'COOKIE_EDITOR_JSON' }
  if (!value || typeof value !== 'object') throw new CookieContractError(400, 'COOKIE_FORMAT_UNRECOGNIZED')
  const object = value as Record<string, unknown>
  if ('data' in object || 'cookies' in object) {
    let inner = object.data ?? object.cookies
    if (typeof inner === 'string') {
      try { inner = JSON.parse(inner) } catch { throw new CookieContractError(400, 'COOKIE_FORMAT_UNRECOGNIZED') }
    }
    return parseJsonValue(inner, true)
  }
  const entries = Object.entries(object)
  if (!entries.length || entries.some(([, item]) => typeof item === 'object' || item === null)) {
    throw new CookieContractError(400, 'COOKIE_FORMAT_UNRECOGNIZED')
  }
  return {
    rows: entries.map(([name, item]) => ({ name, value: item, domain: '.google.com', path: '/' })),
    format: 'JSON_NAME_VALUE_MAP',
  }
}

function parseNetscape(text: string): unknown[] {
  const rows: unknown[] = []
  for (const original of text.split(/\r?\n/)) {
    const line = original.trim()
    if (!line || line.startsWith('#')) continue
    const parts = original.split('\t')
    if (parts.length < 7) throw new CookieContractError(400, 'COOKIE_FORMAT_UNRECOGNIZED')
    const [domain, , path, secure, expires, name, ...value] = parts
    rows.push({ domain, path, secure: secure.toUpperCase() === 'TRUE', expires, name, value: value.join('\t') })
  }
  if (!rows.length) throw new CookieContractError(400, 'COOKIE_FORMAT_UNRECOGNIZED')
  return rows
}

function parseHeader(text: string): unknown[] {
  const source = text.toLowerCase().startsWith('cookie:') ? text.slice(text.indexOf(':') + 1) : text
  const rows: unknown[] = []
  for (const part of source.split(';')) {
    const segment = part.trim()
    if (!segment) continue
    const index = segment.indexOf('=')
    if (index <= 0) throw new CookieContractError(400, 'COOKIE_FORMAT_UNRECOGNIZED')
    rows.push({ name: segment.slice(0, index).trim(), value: segment.slice(index + 1), domain: '.google.com', path: '/' })
  }
  if (!rows.length) throw new CookieContractError(400, 'COOKIE_FORMAT_UNRECOGNIZED')
  return rows
}

function expired(cookie: NormalizedCookie, now: number): boolean {
  return cookie.expiresAt !== null && cookie.expiresAt <= now
}

function preferCookie(current: NormalizedCookie | undefined, candidate: NormalizedCookie, now: number): NormalizedCookie {
  if (!current) return candidate
  const currentExpired = expired(current, now)
  const candidateExpired = expired(candidate, now)
  if (currentExpired && !candidateExpired) return candidate
  if (!currentExpired && candidateExpired) return current
  return candidate
}

export function parseCookieSession(raw: string): ParsedCookieSession {
  const bytes = new TextEncoder().encode(raw).byteLength
  if (!raw.trim()) throw new CookieContractError(400, 'COOKIE_FORMAT_UNRECOGNIZED')
  if (bytes > MAX_COOKIE_INPUT_BYTES) throw new CookieContractError(413, 'BODY_TOO_LARGE')
  const text = raw.trim()
  let rows: unknown[]
  let format: CookieFormat
  if (text.startsWith('[') || text.startsWith('{')) {
    let decoded: unknown
    try { decoded = JSON.parse(text) } catch { throw new CookieContractError(400, 'COOKIE_FORMAT_UNRECOGNIZED') }
    const parsed = parseJsonValue(decoded)
    rows = parsed.rows
    format = parsed.format
  } else if (text.includes('\t') && (text.includes('# Netscape HTTP Cookie File') || text.split('\t').length >= 7)) {
    rows = parseNetscape(text)
    format = 'NETSCAPE'
  } else {
    rows = parseHeader(text)
    format = 'COOKIE_HEADER_STRING'
  }

  const now = Date.now()
  const normalized = rows.map(normalizeCookie)
  const authSeen = normalized.some((cookie) => AUTH_COOKIE_NAMES.has(cookie.name))
  const deduplicated = new Map<string, NormalizedCookie>()
  for (const cookie of normalized) {
    const key = `${cookie.name}\n${cookie.domain}\n${cookie.path}`
    deduplicated.set(key, preferCookie(deduplicated.get(key), cookie, now))
  }
  const cookies = [...deduplicated.values()].filter((cookie) => !expired(cookie, now))
  const authCookies = cookies.filter((cookie) => AUTH_COOKIE_NAMES.has(cookie.name))
  if (!authCookies.length) {
    throw new CookieContractError(authSeen ? 401 : 400, authSeen ? 'COOKIE_AUTH_EXPIRED' : 'COOKIE_SET_INCOMPLETE')
  }
  const authExpirations = authCookies.map((cookie) => cookie.expiresAt).filter((value): value is number => value !== null)
  const authHasSessionCookie = authCookies.some((cookie) => cookie.expiresAt === null)
  return {
    cookies,
    format,
    expiresAt: authHasSessionCookie || !authExpirations.length ? null : Math.max(...authExpirations),
    totalParsed: normalized.length,
    expiredDropped: normalized.filter((cookie) => expired(cookie, now)).length,
    retainedCount: cookies.length,
  }
}

function cookieHeader(cookies: readonly NormalizedCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

function coordinatesFromProvider(body: string): CookiePoint | null {
  const patterns = [
    /\[null,(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)\]/g,
    /\[null,\[(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)\]\]/g,
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(body))) {
      const lng = Number(match[1])
      const lat = Number(match[2])
      if (Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { lat, lng, accuracyM: null, capturedAt: new Date().toISOString() }
      }
    }
  }
  return null
}

export async function probeGoogleCookieSession(cookies: readonly NormalizedCookie[]): Promise<CookieProbeResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort('PROVIDER_TIMEOUT'), PROVIDER_TIMEOUT_MS)
  try {
    const response = await fetch(PROVIDER_URL, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        Cookie: cookieHeader(cookies),
        Referer: 'https://www.google.com/maps',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36',
        'X-Goog-AuthUser': '0',
      },
    })
    const location = response.headers.get('Location') ?? ''
    if (response.status === 401 || response.status === 403 || location.includes('accounts.google.com')) {
      return { ok: false, status: 401, code: 'COOKIE_AUTH_EXPIRED' }
    }
    if (response.status >= 500 || response.status === 429) return { ok: false, status: 503, code: 'COOKIE_PROVIDER_UNAVAILABLE' }
    const body = (await response.text()).slice(0, 1_000_000)
    if (body.includes('accounts.google.com/ServiceLogin') || body.includes('signin/v2')) {
      return { ok: false, status: 401, code: 'COOKIE_AUTH_EXPIRED' }
    }
    if (!response.ok) return { ok: false, status: 503, code: 'COOKIE_PROVIDER_UNAVAILABLE' }
    const point = coordinatesFromProvider(body)
    return point ? { ok: true, state: 'ready', point } : { ok: true, state: 'no_location', point: null }
  } catch {
    return { ok: false, status: 503, code: 'COOKIE_PROVIDER_UNAVAILABLE' }
  } finally {
    clearTimeout(timeout)
  }
}

function metadata(session: PersistedCookieSession): CookieSessionPublicStatus {
  return {
    state: session.state,
    policyVersion: COOKIE_POLICY_VERSION,
    format: session.format,
    cookieCount: session.cookieCount,
    totalParsed: session.totalParsed,
    expiredDropped: session.expiredDropped,
    retainedCount: session.retainedCount,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    validatedAt: session.validatedAt,
    locationAvailable: session.locationAvailable,
  }
}

function bytes(value: ArrayBuffer): Uint8Array {
  return new Uint8Array(value)
}

function ownedArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer
}

function encryptionMaterial(sessionId: string, ownerToken: string): Uint8Array {
  return new TextEncoder().encode(`${ENCRYPTION_CONTEXT}\u0000${sessionId}\u0000${ownerToken}`)
}

function additionalData(sessionId: string): Uint8Array {
  return new TextEncoder().encode(`${COOKIE_POLICY_VERSION}\u0000${sessionId}`)
}

async function encryptionKey(sessionId: string, ownerToken: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', encryptionMaterial(sessionId, ownerToken))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

async function sealPayload(sessionId: string, ownerToken: string, payload: EncryptedCookiePayload): Promise<{ iv: ArrayBuffer; ciphertext: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(sessionId), tagLength: 128 },
    await encryptionKey(sessionId, ownerToken),
    plaintext,
  )
  plaintext.fill(0)
  return { iv: ownedArrayBuffer(iv), ciphertext }
}

async function openPayload(session: PersistedCookieSession, ownerToken: string): Promise<EncryptedCookiePayload> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes(session.iv), additionalData: additionalData(session.sessionId), tagLength: 128 },
      await encryptionKey(session.sessionId, ownerToken),
      session.ciphertext,
    )
    const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as EncryptedCookiePayload
    if (!decoded || !Array.isArray(decoded.cookies) || !('point' in decoded)) throw new Error('INVALID_PAYLOAD')
    return decoded
  } catch {
    throw new CookieContractError(503, 'STORAGE_UNAVAILABLE')
  }
}

export class CookieSessionDurableRuntime {
  constructor(
    private readonly storage: CookieSessionStorage,
    private readonly probe: CookieProbe = probeGoogleCookieSession,
    private readonly clock: () => number = Date.now,
  ) {}

  private async authorized(sessionId: string, ownerToken: string): Promise<RpcResult<PersistedCookieSession>> {
    if (!TOKEN.test(sessionId) || !TOKEN.test(ownerToken)) return { ok: false, status: 404, code: 'NOT_FOUND' }
    const session = await this.storage.get<PersistedCookieSession>(COOKIE_SESSION_STORAGE_KEY)
    if (!session || session.version !== 3 || session.sessionId !== sessionId) return { ok: false, status: 404, code: 'NOT_FOUND' }
    if (session.expiresAtMs <= this.clock()) {
      await this.storage.delete(COOKIE_SESSION_STORAGE_KEY)
      return { ok: false, status: 410, code: 'COOKIE_SESSION_EXPIRED' }
    }
    const verifier = await capabilityVerifier(ownerToken)
    if (verifier !== session.ownerVerifier) return { ok: false, status: 404, code: 'NOT_FOUND' }
    return { ok: true, value: session }
  }

  async importSession(input: CookieSessionImportInput): Promise<RpcResult<CookieSessionPublicStatus>> {
    try {
      if (!TOKEN.test(input.sessionId) || !TOKEN.test(input.ownerToken)) return { ok: false, status: 400, code: 'REQUEST_INVALID' }
      const parsed = parseCookieSession(input.raw)
      const probe = await this.probe(parsed.cookies)
      if (probe.ok === false) return probe
      const now = this.clock()
      const duration = Math.max(MIN_COOKIE_SESSION_DURATION_MS, Math.min(MAX_COOKIE_SESSION_DURATION_MS, Math.floor(input.durationMs || DEFAULT_COOKIE_SESSION_DURATION_MS)))
      const expiresAtMs = now + duration
      const encrypted = await sealPayload(input.sessionId, input.ownerToken, { cookies: parsed.cookies, point: probe.point })
      const session: PersistedCookieSession = {
        version: 3,
        sessionId: input.sessionId,
        ownerVerifier: await capabilityVerifier(input.ownerToken),
        format: parsed.format,
        cookieCount: parsed.cookies.length,
        totalParsed: parsed.totalParsed,
        expiredDropped: parsed.expiredDropped,
        retainedCount: parsed.retainedCount,
        expiresAtMs,
        validatedAt: new Date(now).toISOString(),
        state: probe.state,
        locationAvailable: probe.point !== null,
        lastProbeAtMs: now,
        ...encrypted,
      }
      await this.storage.put(COOKIE_SESSION_STORAGE_KEY, session)
      return { ok: true, value: metadata(session) }
    } catch (error) {
      if (error instanceof CookieContractError) return { ok: false, status: error.status, code: error.code }
      return { ok: false, status: 400, code: 'REQUEST_INVALID' }
    }
  }

  async status(sessionId: string, ownerToken: string): Promise<RpcResult<CookieSessionPublicStatus>> {
    const authorized = await this.authorized(sessionId, ownerToken)
    return authorized.ok ? { ok: true, value: metadata(authorized.value) } : authorized
  }

  async point(sessionId: string, ownerToken: string): Promise<RpcResult<CookieSessionPointResponse>> {
    const authorized = await this.authorized(sessionId, ownerToken)
    if (!authorized.ok) return authorized
    try {
      const payload = await openPayload(authorized.value, ownerToken)
      return {
        ok: true,
        value: {
          state: authorized.value.state,
          point: payload.point,
          validatedAt: authorized.value.validatedAt,
        },
      }
    } catch (error) {
      return error instanceof CookieContractError
        ? { ok: false, status: error.status, code: error.code }
        : { ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }
    }
  }

  async refresh(sessionId: string, ownerToken: string): Promise<RpcResult<CookieSessionPublicStatus>> {
    const authorized = await this.authorized(sessionId, ownerToken)
    if (!authorized.ok) return authorized
    const session = authorized.value
    const now = this.clock()
    if (now - session.lastProbeAtMs < COOKIE_REFRESH_MIN_INTERVAL_MS) return { ok: false, status: 429, code: 'FREQUENCY_LIMIT' }
    try {
      const payload = await openPayload(session, ownerToken)
      const probe = await this.probe(payload.cookies)
      session.lastProbeAtMs = now
      if (probe.ok === false) {
        if (probe.code === 'COOKIE_AUTH_EXPIRED') await this.storage.delete(COOKIE_SESSION_STORAGE_KEY)
        else await this.storage.put(COOKIE_SESSION_STORAGE_KEY, session)
        return probe
      }
      const encrypted = await sealPayload(session.sessionId, ownerToken, { cookies: payload.cookies, point: probe.point })
      session.state = probe.state
      session.locationAvailable = probe.point !== null
      session.validatedAt = new Date(now).toISOString()
      session.iv = encrypted.iv
      session.ciphertext = encrypted.ciphertext
      await this.storage.put(COOKIE_SESSION_STORAGE_KEY, session)
      return { ok: true, value: metadata(session) }
    } catch (error) {
      return error instanceof CookieContractError
        ? { ok: false, status: error.status, code: error.code }
        : { ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }
    }
  }

  async delete(sessionId: string, ownerToken: string): Promise<RpcResult<null>> {
    const authorized = await this.authorized(sessionId, ownerToken)
    if (!authorized.ok) return authorized
    await this.storage.delete(COOKIE_SESSION_STORAGE_KEY)
    return { ok: true, value: null }
  }
}

class InMemoryCookieStorage implements CookieSessionStorage {
  private value: PersistedCookieSession | undefined

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return key === COOKIE_SESSION_STORAGE_KEY ? this.value as T | undefined : undefined
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    if (key === COOKIE_SESSION_STORAGE_KEY) this.value = value as PersistedCookieSession
  }

  async delete(key: string): Promise<boolean> {
    if (key !== COOKIE_SESSION_STORAGE_KEY || !this.value) return false
    this.value = undefined
    return true
  }
}

export class CookieSessionMemoryRuntime extends CookieSessionDurableRuntime {
  constructor(probe: CookieProbe = probeGoogleCookieSession, clock: () => number = Date.now) {
    super(new InMemoryCookieStorage(), probe, clock)
  }
}
