export type CookieSessionState = 'ready' | 'no_location'
export type CookieSessionFormat = 'COOKIE_EDITOR_JSON' | 'WRAPPED_JSON' | 'COOKIE_HEADER_STRING' | 'NETSCAPE' | 'JSON_NAME_VALUE_MAP'

export interface CookieSessionPoint {
  lat: number
  lng: number
  accuracyM: number | null
  capturedAt: string
}

export interface CookieSessionStatus {
  state: CookieSessionState
  policyVersion: string
  format: CookieSessionFormat
  cookieCount: number
  expiresAt: string
  validatedAt: string
  locationAvailable: boolean
}

export interface CookieSessionPointResponse {
  state: CookieSessionState
  point: CookieSessionPoint | null
  validatedAt: string
}

export interface CookieSessionHandle extends CookieSessionStatus {
  sessionId: string
  ownerToken: string
  storagePolicy: 'memory-only'
}

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

export async function importCookieSession(raw: string, signal?: AbortSignal): Promise<CookieSessionHandle> {
  const response = await fetch('/api/cookie-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw, durationMs: 60 * 60 * 1000 }),
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  })
  return json<CookieSessionHandle>(response)
}

function ownerHeaders(handle: Pick<CookieSessionHandle, 'ownerToken'>): HeadersInit {
  return { 'X-Stracker-Cookie-Owner': handle.ownerToken }
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

export async function refreshCookieSession(handle: CookieSessionHandle, signal?: AbortSignal): Promise<CookieSessionStatus> {
  const response = await fetch(`/api/cookie-sessions/${encodeURIComponent(handle.sessionId)}/refresh`, {
    method: 'POST', headers: ownerHeaders(handle), cache: 'no-store', credentials: 'same-origin', signal,
  })
  return json<CookieSessionStatus>(response)
}

export async function deleteCookieSession(handle: CookieSessionHandle, keepalive = false): Promise<void> {
  const response = await fetch(`/api/cookie-sessions/${encodeURIComponent(handle.sessionId)}`, {
    method: 'DELETE', headers: ownerHeaders(handle), cache: 'no-store', credentials: 'same-origin', keepalive,
  })
  if (!response.ok && response.status !== 404 && response.status !== 410) await json(response)
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
