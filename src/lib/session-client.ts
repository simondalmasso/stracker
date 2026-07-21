export type SessionState =
  | 'UNCONFIGURED'
  | 'IMPORTING'
  | 'VALIDATING'
  | 'READY'
  | 'STALE'
  | 'EXPIRED'
  | 'NO_LOCATION'
  | 'ERROR'

export type CookieFormat =
  | 'COOKIE_EDITOR_JSON'
  | 'WRAPPED_JSON'
  | 'COOKIE_HEADER_STRING'
  | 'NETSCAPE'
  | null

export interface SessionStatus {
  state: SessionState
  map_unlocked: boolean
  configured: boolean
  format?: CookieFormat
  cookie_count: number
  critical_present: string[]
  critical_missing: string[]
  validated_at?: number
  validation_code?: string
  message?: string
  action?: string
}

export interface SessionImportResponse extends SessionStatus {
  status: 'ok' | 'error'
  code?: string
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & {
    message?: string
    action?: string
  }
  if (!response.ok) {
    const message = body.message || `HTTP ${response.status}`
    const error = new Error(message) as Error & { payload?: unknown; status?: number }
    error.payload = body
    error.status = response.status
    throw error
  }
  return body
}

export async function establishApplicationSession(): Promise<void> {
  const response = await fetch('/api/app/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    cache: 'no-store',
  })
  await readJson(response)
}

export async function getSessionStatus(): Promise<SessionStatus> {
  const response = await fetch('/api/session/status', {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
  })
  return readJson<SessionStatus>(response)
}

export async function importAuthorizedSession(raw: string): Promise<SessionImportResponse> {
  const response = await fetch('/api/session/import', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: raw,
    cache: 'no-store',
  })
  return readJson<SessionImportResponse>(response)
}

export async function clearAuthorizedSession(): Promise<void> {
  const response = await fetch('/api/session/clear', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    cache: 'no-store',
  })
  await readJson(response)
}

export function detectCookieFormat(raw: string): CookieFormat {
  const text = raw.trim()
  if (!text) return null
  if (text.startsWith('{')) return 'WRAPPED_JSON'
  if (text.startsWith('[')) return 'COOKIE_EDITOR_JSON'
  if (text.includes('# Netscape HTTP Cookie File') || (text.includes('\t') && text.split('\t').length >= 7)) {
    return 'NETSCAPE'
  }
  if (text.toLowerCase().startsWith('cookie:') || text.includes('=')) return 'COOKIE_HEADER_STRING'
  return null
}

export const unlockedSessionStates = new Set<SessionState>(['READY', 'STALE', 'NO_LOCATION'])
