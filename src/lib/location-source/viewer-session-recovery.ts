import type { NativeViewerExchangeResponse } from './contracts'

export const VIEWER_SESSION_STORAGE_KEY = 'stracker.viewer-session.v1'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MAX_RECOVERY_TTL_MS = 4 * 60 * 60 * 1000

export interface SessionStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function defaultStorage(): SessionStorageLike | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function isRecoverableViewerSession(
  value: unknown,
  nowMs = Date.now(),
): value is NativeViewerExchangeResponse {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<NativeViewerExchangeResponse>
  if (!TOKEN_PATTERN.test(candidate.sessionId ?? '')) return false
  if (!TOKEN_PATTERN.test(candidate.viewerSessionToken ?? '')) return false
  if (!Number.isSafeInteger(candidate.viewerGeneration) || Number(candidate.viewerGeneration) < 1) return false
  if (typeof candidate.expiresAt !== 'string') return false
  const expiresAtMs = Date.parse(candidate.expiresAt)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return false
  return expiresAtMs - nowMs <= MAX_RECOVERY_TTL_MS + 60_000
}

export function persistViewerSession(
  session: NativeViewerExchangeResponse,
  storage: SessionStorageLike | null = defaultStorage(),
): boolean {
  if (!storage || !isRecoverableViewerSession(session)) return false
  try {
    storage.setItem(VIEWER_SESSION_STORAGE_KEY, JSON.stringify(session))
    return true
  } catch {
    return false
  }
}

export function readPersistedViewerSession(
  storage: SessionStorageLike | null = defaultStorage(),
  nowMs = Date.now(),
): NativeViewerExchangeResponse | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(VIEWER_SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!isRecoverableViewerSession(parsed, nowMs)) {
      storage.removeItem(VIEWER_SESSION_STORAGE_KEY)
      return null
    }
    return parsed
  } catch {
    try { storage.removeItem(VIEWER_SESSION_STORAGE_KEY) } catch {}
    return null
  }
}

export function clearPersistedViewerSession(
  storage: SessionStorageLike | null = defaultStorage(),
): void {
  try { storage?.removeItem(VIEWER_SESSION_STORAGE_KEY) } catch {}
}
