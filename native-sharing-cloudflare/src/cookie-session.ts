import { capabilityVerifier } from '../../native-sharing/src/security.js'
import type { RpcResult, RuntimeErrorCode } from './runtime-contracts.js'

export const COOKIE_POLICY_VERSION = 'google-maps-cookie-durable-v1'
export const MAX_COOKIE_INPUT_BYTES = 64 * 1024
export const DEFAULT_COOKIE_SESSION_DURATION_MS = 24 * 60 * 60 * 1000
export const MIN_COOKIE_SESSION_DURATION_MS = 5 * 60 * 1000
export const MAX_COOKIE_SESSION_DURATION_MS = 24 * 60 * 60 * 1000
export const COOKIE_REFRESH_MIN_INTERVAL_MS = 10_000
export const COOKIE_SAMPLE_INTERVAL_MS = 60_000
export const COOKIE_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000
export const COOKIE_MOBILITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const PROVIDER_TIMEOUT_MS = 8_000
const PROVIDER_URL = 'https://www.google.com/maps/rpc/locationsharing/read?authuser=0&hl=es&gl=ar&pb='
const AUTH_COOKIE_NAMES = new Set(['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'])
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const GOOGLE_DOMAIN = /^(?:[a-z0-9-]+\.)*google\.com$/i
const TOKEN = /^[A-Za-z0-9_-]{43}$/

export type CookieFormat = 'COOKIE_EDITOR_JSON' | 'WRAPPED_JSON' | 'COOKIE_HEADER_STRING' | 'NETSCAPE' | 'JSON_NAME_VALUE_MAP'
export type CookieProviderState = 'ready' | 'no_location'
export type CookieSessionState = CookieProviderState | 'auth_expired'
export type CookieSourceQuality = 'provider_timestamp' | 'stracker_observed_at'

export interface CookiePoint {
  lat: number
  lng: number
  accuracyM: number | null
  capturedAt: string
  observedAt?: string
  sourceQuality?: CookieSourceQuality
}

export interface NormalizedCookie {
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
  authExpiresAt: number | null
  totalParsed: number
  expiredDropped: number
  invalidDropped: number
  retainedCount: number
}

export interface CookieSessionImportInput {
  sessionId: string
  ownerVerifier: string
  raw: string
  durationMs: number
}

export interface CookieSessionPublicStatus {
  state: CookieSessionState
  policyVersion: string
  format: CookieFormat
  cookieCount: number
  totalParsed: number
  expiredDropped: number
  invalidDropped: number
  retainedCount: number
  expiresAt: string
  validatedAt: string
  locationAvailable: boolean
}

export interface CookieSessionPointResponse {
  state: CookieSessionState
  point: CookiePoint | null
  validatedAt: string
}

export interface CookieSessionCreateResponse extends CookieSessionPublicStatus {
  status: 'ok'
  sessionId: string
  ownerToken: string
  mobilityScope: string
  storagePolicy: 'encrypted-durable'
}

export type CookieProbeResult =
  | { ok: true; state: CookieProviderState; point: CookiePoint | null; points?: readonly CookiePoint[] }
  | { ok: false; status: number; code: RuntimeErrorCode }

export type CookieProbe = (cookies: readonly NormalizedCookie[]) => Promise<CookieProbeResult>

export class CookieContractError extends Error {
  constructor(readonly status: number, readonly code: RuntimeErrorCode) {
    super(code)
    this.name = 'CookieContractError'
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

function rawCookieName(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const name = String((value as Record<string, unknown>).name ?? '').trim()
  return COOKIE_NAME.test(name) ? name : null
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
  const normalized: NormalizedCookie[] = []
  let invalidDropped = 0
  let authSeen = false
  for (const row of rows) {
    const rawName = rawCookieName(row)
    if (rawName && AUTH_COOKIE_NAMES.has(rawName)) authSeen = true
    try {
      normalized.push(normalizeCookie(row))
    } catch (error) {
      if (error instanceof CookieContractError && rawName && !AUTH_COOKIE_NAMES.has(rawName)) {
        invalidDropped += 1
        continue
      }
      throw error
    }
  }
  if (normalized.some((cookie) => AUTH_COOKIE_NAMES.has(cookie.name))) authSeen = true

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
  const authExpiresAt = authCookies.some((cookie) => cookie.expiresAt === null)
    ? null
    : Math.max(...authCookies.map((cookie) => cookie.expiresAt as number))
  return {
    cookies,
    format,
    expiresAt: authExpiresAt,
    authExpiresAt,
    totalParsed: rows.length,
    expiredDropped: normalized.filter((cookie) => expired(cookie, now)).length,
    invalidDropped,
    retainedCount: cookies.length,
  }
}

function cookieHeader(cookies: readonly NormalizedCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

function coordinatesFromProvider(body: string, observedAt: string): CookiePoint | null {
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
        return {
          lat,
          lng,
          accuracyM: null,
          capturedAt: observedAt,
          observedAt,
          sourceQuality: 'stracker_observed_at',
        }
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
    const observedAt = new Date().toISOString()
    const point = coordinatesFromProvider(body, observedAt)
    return point ? { ok: true, state: 'ready', point, points: [point] } : { ok: true, state: 'no_location', point: null, points: [] }
  } catch {
    return { ok: false, status: 503, code: 'COOKIE_PROVIDER_UNAVAILABLE' }
  } finally {
    clearTimeout(timeout)
  }
}

interface MemorySession {
  sessionId: string
  ownerVerifier: string
  cookies: NormalizedCookie[]
  format: CookieFormat
  totalParsed: number
  expiredDropped: number
  invalidDropped: number
  retainedCount: number
  expiresAtMs: number
  validatedAt: string
  state: CookieProviderState
  point: CookiePoint | null
  lastProbeAtMs: number
}

function metadata(session: MemorySession): CookieSessionPublicStatus {
  return {
    state: session.state,
    policyVersion: COOKIE_POLICY_VERSION,
    format: session.format,
    cookieCount: session.cookies.length,
    totalParsed: session.totalParsed,
    expiredDropped: session.expiredDropped,
    invalidDropped: session.invalidDropped,
    retainedCount: session.retainedCount,
    expiresAt: new Date(session.expiresAtMs).toISOString(),
    validatedAt: session.validatedAt,
    locationAvailable: session.point !== null,
  }
}

export class CookieSessionMemoryRuntime {
  private session: MemorySession | null = null

  constructor(private readonly probe: CookieProbe = probeGoogleCookieSession) {}

  private async authorized(sessionId: string, ownerToken: string): Promise<RpcResult<MemorySession>> {
    if (!this.session || this.session.sessionId !== sessionId || !TOKEN.test(ownerToken)) {
      return { ok: false, status: 404, code: 'NOT_FOUND' }
    }
    if (this.session.expiresAtMs <= Date.now()) {
      this.session = null
      return { ok: false, status: 410, code: 'COOKIE_SESSION_EXPIRED' }
    }
    const verifier = await capabilityVerifier(ownerToken)
    if (verifier !== this.session.ownerVerifier) return { ok: false, status: 404, code: 'NOT_FOUND' }
    return { ok: true, value: this.session }
  }

  async importSession(input: CookieSessionImportInput): Promise<RpcResult<CookieSessionPublicStatus>> {
    try {
      if (!TOKEN.test(input.sessionId) || !TOKEN.test(input.ownerVerifier)) {
        return { ok: false, status: 400, code: 'REQUEST_INVALID' }
      }
      const parsed = parseCookieSession(input.raw)
      const probe = await this.probe(parsed.cookies)
      if (!probe.ok) return probe
      const now = Date.now()
      const duration = Math.max(MIN_COOKIE_SESSION_DURATION_MS, Math.min(MAX_COOKIE_SESSION_DURATION_MS, Math.floor(input.durationMs || DEFAULT_COOKIE_SESSION_DURATION_MS)))
      const expiresAtMs = Math.min(now + duration, parsed.authExpiresAt ?? Number.POSITIVE_INFINITY)
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return { ok: false, status: 401, code: 'COOKIE_AUTH_EXPIRED' }
      this.session = {
        sessionId: input.sessionId,
        ownerVerifier: input.ownerVerifier,
        cookies: parsed.cookies,
        format: parsed.format,
        totalParsed: parsed.totalParsed,
        expiredDropped: parsed.expiredDropped,
        invalidDropped: parsed.invalidDropped,
        retainedCount: parsed.retainedCount,
        expiresAtMs,
        validatedAt: new Date(now).toISOString(),
        state: probe.state,
        point: probe.point,
        lastProbeAtMs: now,
      }
      return { ok: true, value: metadata(this.session) }
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
    return { ok: true, value: { state: authorized.value.state, point: authorized.value.point, validatedAt: authorized.value.validatedAt } }
  }

  async refresh(sessionId: string, ownerToken: string): Promise<RpcResult<CookieSessionPublicStatus>> {
    const authorized = await this.authorized(sessionId, ownerToken)
    if (!authorized.ok) return authorized
    const session = authorized.value
    if (Date.now() - session.lastProbeAtMs < COOKIE_REFRESH_MIN_INTERVAL_MS) {
      return { ok: false, status: 429, code: 'FREQUENCY_LIMIT' }
    }
    const probe = await this.probe(session.cookies)
    session.lastProbeAtMs = Date.now()
    if (!probe.ok) {
      if (probe.code === 'COOKIE_AUTH_EXPIRED') this.session = null
      return probe
    }
    session.state = probe.state
    session.point = probe.point
    session.validatedAt = new Date().toISOString()
    return { ok: true, value: metadata(session) }
  }

  async delete(sessionId: string, ownerToken: string): Promise<RpcResult<null>> {
    const authorized = await this.authorized(sessionId, ownerToken)
    if (!authorized.ok) return authorized
    this.session = null
    return { ok: true, value: null }
  }
}
