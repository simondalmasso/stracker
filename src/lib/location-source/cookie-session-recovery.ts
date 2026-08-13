import {
  clearPersistedViewerSession,
  persistViewerSession,
  readPersistedViewerSession,
} from './viewer-session-recovery'

interface CookieSessionAuthHandle {
  sessionId: string
  ownerToken: string
}

export interface StoredCookieSessionHandle extends CookieSessionAuthHandle {
  expiresAt: string
}

export function persistCookieSessionHandle(handle: CookieSessionAuthHandle, expiresAt: string): boolean {
  return persistViewerSession({
    sessionId: handle.sessionId,
    viewerSessionToken: handle.ownerToken,
    viewerGeneration: 1,
    expiresAt,
  })
}

export function readPersistedCookieSessionHandle(): StoredCookieSessionHandle | null {
  const session = readPersistedViewerSession()
  if (!session) return null
  return {
    sessionId: session.sessionId,
    ownerToken: session.viewerSessionToken,
    expiresAt: session.expiresAt,
  }
}

export function clearPersistedCookieSessionHandle(): void {
  clearPersistedViewerSession()
}
