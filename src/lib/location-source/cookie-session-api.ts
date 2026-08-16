export type CookieSessionState = 'ready' | 'no_location' | 'auth_expired'
export type CookieSessionFormat = 'COOKIE_EDITOR_JSON' | 'WRAPPED_JSON' | 'COOKIE_HEADER_STRING' | 'NETSCAPE' | 'JSON_NAME_VALUE_MAP'
export type CookieSourceQuality = 'provider_timestamp' | 'stracker_observed_at'
export type CookieHistoryProvenance = 'observed' | 'inferred'
export type CookieInferenceConfidence = 'high' | 'medium' | 'low'

export interface CookieSessionPoint {
  lat: number
  lng: number
  accuracyM: number | null
  capturedAt: string
  observedAt?: string
  sourceQuality?: CookieSourceQuality
}

export interface CookieSessionStatus {
  state: CookieSessionState
  policyVersion: string
  format: CookieSessionFormat
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
  point: CookieSessionPoint | null
  validatedAt: string
}

export interface CookieHistoryPoint extends CookieSessionPoint {
  observedAt: string
  provenance: 'observed'
  sourceQuality: CookieSourceQuality
}

export interface CookieHistorySegment {
  id: string
  provenance: CookieHistoryProvenance
  confidence: CookieInferenceConfidence
  method: 'provider-observed' | 'learned-corridor-prior' | 'generic-plausible-fallback'
  startedAt: string
  endedAt: string
  points: Array<{ lat: number; lng: number }>
}

export interface CookieKeyframe {
  id: string
  type:
    | 'session_observation_start'
    | 'movement_start'
    | 'movement_stop'
    | 'dwell_start'
    | 'dwell_end'
    | 'significant_displacement'
    | 'major_direction_change'
    | 'mode_change'
    | 'data_gap_start'
    | 'data_gap_recovered'
  at: string
  lat: number
  lng: number
  provenance: CookieHistoryProvenance
  confidence: CookieInferenceConfidence
}

export interface CookieHistoryResponse {
  state: CookieSessionState
  windowStart: string
  windowEnd: string
  points: CookieHistoryPoint[]
  segments: CookieHistorySegment[]
  keyframes: CookieKeyframe[]
  rawRetentionHours: 24
  derivedModelRetentionDays: 30
  inferenceTruthLabelRequired: true
}

export interface CookieSessionHandle extends CookieSessionStatus {
  sessionId: string
  ownerToken: string
  mobilityScope: string
  storagePolicy: 'encrypted-durable'
}

const HANDLE_KEY = 'stracker.cookie.handle.v2'
const MOBILITY_SCOPE_KEY = 'stracker.cookie.mobility-scope.v1'
const TOKEN = /^[A-Za-z0-9_-]{43}$/

export class CookieSessionApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
    this.name = 'CookieSessionApiError'
  }
}

async function json<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as ({ error?: string } & T) | null
  if (!response.ok || !payload) throw new CookieSessionApiError(payload?.error || 'REQUEST_FAILED', response.status)
  return payload
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function getOrCreateMobilityScope(): string {
  if (typeof window === 'undefined') return ''
  const existing = window.localStorage.getItem(MOBILITY_SCOPE_KEY) || ''
  if (TOKEN.test(existing)) return existing
  const created = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  if (!TOKEN.test(created)) throw new CookieSessionApiError('REQUEST_FAILED', 0)
  window.localStorage.setItem(MOBILITY_SCOPE_KEY, created)
  return created
}

function validHandle(value: unknown): value is CookieSessionHandle {
  if (!value || typeof value !== 'object') return false
  const handle = value as Partial<CookieSessionHandle>
  return TOKEN.test(handle.sessionId || '')
    && TOKEN.test(handle.ownerToken || '')
    && TOKEN.test(handle.mobilityScope || '')
    && handle.storagePolicy === 'encrypted-durable'
    && typeof handle.expiresAt === 'string'
    && Number.isFinite(Date.parse(handle.expiresAt))
}

export function loadCookieSessionHandle(): CookieSessionHandle | null {
  if (typeof window === 'undefined') return null
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(HANDLE_KEY) || 'null') as unknown
    if (!validHandle(parsed) || Date.parse(parsed.expiresAt) <= Date.now()) {
      window.sessionStorage.removeItem(HANDLE_KEY)
      return null
    }
    return parsed
  } catch {
    window.sessionStorage.removeItem(HANDLE_KEY)
    return null
  }
}

export function persistCookieSessionHandle(handle: CookieSessionHandle): void {
  if (typeof window === 'undefined' || !validHandle(handle)) return
  window.sessionStorage.setItem(HANDLE_KEY, JSON.stringify(handle))
}

export function clearCookieSessionHandle(): void {
  if (typeof window !== 'undefined') window.sessionStorage.removeItem(HANDLE_KEY)
}

export async function importCookieSession(raw: string, signal?: AbortSignal): Promise<CookieSessionHandle> {
  const response = await fetch('/api/cookie-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw, durationMs: 24 * 60 * 60 * 1000, mobilityScope: getOrCreateMobilityScope() }),
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  })
  const handle = await json<CookieSessionHandle>(response)
  persistCookieSessionHandle(handle)
  return handle
}

function ownerHeaders(handle: Pick<CookieSessionHandle, 'ownerToken' | 'mobilityScope'>): HeadersInit {
  return {
    'X-Stracker-Cookie-Owner': handle.ownerToken,
    'X-Stracker-Mobility-Scope': handle.mobilityScope,
  }
}

export async function readCookieSession(handle: CookieSessionHandle, signal?: AbortSignal): Promise<CookieSessionStatus> {
  const response = await fetch(`/api/cookie-sessions/${encodeURIComponent(handle.sessionId)}/status`, {
    headers: ownerHeaders(handle), cache: 'no-store', credentials: 'same-origin', signal,
  })
  return json<CookieSessionStatus>(response)
}

export async function readCookieSessionPoint(handle: CookieSessionHandle, signal?: AbortSignal): Promise<CookieSessionPointResponse> {
  const response = await fetch(`/api/cookie-sessions/${encodeURIComponent(handle.sessionId)}/point`, {
    headers: ownerHeaders(handle), cache: 'no-store', credentials: 'same-origin', signal,
  })
  return json<CookieSessionPointResponse>(response)
}

export async function readCookieSessionHistory(handle: CookieSessionHandle, since: string, signal?: AbortSignal): Promise<CookieHistoryResponse> {
  const response = await fetch(`/api/cookie-sessions/${encodeURIComponent(handle.sessionId)}/history?since=${encodeURIComponent(since)}`, {
    headers: ownerHeaders(handle), cache: 'no-store', credentials: 'same-origin', signal,
  })
  return json<CookieHistoryResponse>(response)
}

export async function refreshCookieSession(handle: CookieSessionHandle, signal?: AbortSignal): Promise<CookieSessionStatus> {
  const response = await fetch(`/api/cookie-sessions/${encodeURIComponent(handle.sessionId)}/refresh`, {
    method: 'POST', headers: ownerHeaders(handle), cache: 'no-store', credentials: 'same-origin', signal,
  })
  return json<CookieSessionStatus>(response)
}

export async function clearCookieMobility(handle: CookieSessionHandle): Promise<void> {
  const response = await fetch(`/api/cookie-sessions/${encodeURIComponent(handle.sessionId)}/mobility-memory`, {
    method: 'DELETE', headers: ownerHeaders(handle), cache: 'no-store', credentials: 'same-origin',
  })
  if (!response.ok) await json(response)
}

export async function deleteCookieSession(handle: CookieSessionHandle): Promise<void> {
  const response = await fetch(`/api/cookie-sessions/${encodeURIComponent(handle.sessionId)}`, {
    method: 'DELETE', headers: ownerHeaders(handle), cache: 'no-store', credentials: 'same-origin',
  })
  if (!response.ok && response.status !== 404 && response.status !== 410) await json(response)
  clearCookieSessionHandle()
}

export function detectedCookieFormat(raw: string): string {
  const text = raw.trim()
  if (!text) return 'Sin detectar'
  if (text.startsWith('[')) return 'Cookie Editor JSON'
  if (text.startsWith('{')) return 'JSON'
  if (text.includes('\t') && (text.includes('# Netscape HTTP Cookie File') || text.split('\t').length >= 7)) return 'Netscape cookies.txt'
  if (text.toLowerCase().startsWith('cookie:') || text.includes('=')) return 'Cookie Header'
  return 'No reconocido'
}
