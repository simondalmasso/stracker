import type {
  AcceptedNativePoint,
  CreateSessionResponse,
  NativeSharedLocationPoint,
  NativeSharingSession,
  NativeSharingStore,
  OpaqueViewerSession,
  ViewerExchangeResponse,
  ViewerPointsResponse,
  ViewerSessionState,
  ViewerStatusResponse,
} from './contracts.js'
import { validateNativePoint } from './geo.js'
import {
  DEFAULT_SESSION_DURATION_MS,
  EXPIRATION_GRACE_MS,
  MAX_GHOSTRAIL_SEGMENTS,
  MAX_POINTS_PER_RESPONSE,
  MAX_SESSION_DURATION_MS,
  MIN_SESSION_DURATION_MS,
  VIEWER_SESSION_TTL_MS,
} from './limits.js'
import {
  buildViewerCapability,
  capabilityVerifier,
  generateCapability,
  parseViewerCapability,
  verifyCapability,
} from './security.js'

export class NativeSharingError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'NativeSharingError'
  }
}

function boundedDuration(durationMs?: number): number {
  const value = durationMs ?? DEFAULT_SESSION_DURATION_MS
  if (!Number.isFinite(value) || value < MIN_SESSION_DURATION_MS || value > MAX_SESSION_DURATION_MS) {
    throw new NativeSharingError(400, 'DURATION_INVALID', 'Requested duration is outside allowed bounds.')
  }
  return Math.floor(value)
}

function stateAt(session: NativeSharingSession, nowMs: number): NativeSharingSession['state'] {
  if (session.state === 'revoked') return 'revoked'
  return nowMs > Date.parse(session.expiresAt) ? 'expired' : 'active'
}

function viewerState(session: NativeSharingSession, nowMs: number): ViewerSessionState {
  if (!session.lastReceivedAt) return 'active'
  return nowMs - Date.parse(session.lastReceivedAt) > EXPIRATION_GRACE_MS ? 'stale' : 'active'
}

export class NativeSharingService {
  constructor(private readonly store: NativeSharingStore, private readonly now: () => Date = () => new Date()) {}

  async createSession(durationMs?: number): Promise<CreateSessionResponse> {
    const createdAt = this.now()
    const duration = boundedDuration(durationMs)
    for (let attempt = 0; attempt < 3; attempt += 1) {
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
      try {
        await this.store.createSession({ session })
        return { sessionId, emitterToken, viewerCapability: buildViewerCapability(sessionId, viewerToken), expiresAt: session.expiresAt }
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'SESSION_COLLISION') throw error
      }
    }
    throw new NativeSharingError(503, 'CAPABILITY_GENERATION_FAILED', 'Could not create a private session.')
  }

  async appendPoint(sessionId: string, emitterToken: string, input: NativeSharedLocationPoint): Promise<AcceptedNativePoint> {
    const session = await this.authorizeEmitter(sessionId, emitterToken)
    const now = this.now()
    const current = stateAt(session, now.getTime())
    if (current !== 'active') throw new NativeSharingError(410, current === 'revoked' ? 'SESSION_REVOKED' : 'SESSION_EXPIRED', 'Session is no longer active.')
    const previous = await this.store.getLatestPoint(sessionId)
    const point = validateNativePoint(input, session, previous, now.getTime())
    const accepted: AcceptedNativePoint = { ...point, receivedAt: now.toISOString(), sessionId, acceptanceState: 'accepted' }
    try {
      return (await this.store.appendPoint(sessionId, session.lastSequence, accepted)).point
    } catch (error) {
      if (error instanceof Error && error.message === 'SEQUENCE_RACE') throw new NativeSharingError(409, 'SEQUENCE_RACE', 'Point sequence lost a concurrent race.')
      throw error
    }
  }

  async exchangeViewerCapability(viewerCapability: string): Promise<ViewerExchangeResponse> {
    const parsed = parseViewerCapability(viewerCapability)
    if (!parsed) throw new NativeSharingError(404, 'NOT_FOUND', 'Viewer access was not found.')
    const session = await this.store.getSession(parsed.sessionId)
    if (!session || !(await verifyCapability(parsed.viewerToken, session.viewerVerifier))) {
      throw new NativeSharingError(404, 'NOT_FOUND', 'Viewer access was not found.')
    }
    const now = this.now()
    const sharingState = stateAt(session, now.getTime())
    if (sharingState !== 'active') {
      throw new NativeSharingError(410, sharingState === 'revoked' ? 'SESSION_REVOKED' : 'SESSION_EXPIRED', 'Session is no longer readable.')
    }

    const viewerSessionToken = generateCapability()
    const expiresAtMs = Math.min(now.getTime() + VIEWER_SESSION_TTL_MS, Date.parse(session.expiresAt))
    const viewerSession: OpaqueViewerSession = {
      tokenVerifier: await capabilityVerifier(viewerSessionToken),
      sharingSessionId: session.id,
      viewerGeneration: session.viewerGeneration,
      createdAt: now.toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      revokedAt: null,
    }
    await this.store.createViewerSession(session.id, viewerSession, {
      sessionId: session.id,
      expectedViewerVerifier: session.viewerVerifier,
      expectedViewerGeneration: session.viewerGeneration,
      nowIso: now.toISOString(),
    })
    return {
      sessionId: session.id,
      viewerSessionToken,
      viewerGeneration: session.viewerGeneration,
      expiresAt: viewerSession.expiresAt,
    }
  }

  async getStatus(sessionId: string, viewerSessionToken: string): Promise<ViewerStatusResponse> {
    const session = await this.authorizeViewerSession(sessionId, viewerSessionToken)
    return {
      state: viewerState(session, this.now().getTime()),
      expiresAt: session.expiresAt,
      lastUpdate: session.lastReceivedAt,
      pointCount: session.pointCount,
    }
  }

  async getPoints(sessionId: string, viewerSessionToken: string): Promise<ViewerPointsResponse> {
    const session = await this.authorizeViewerSession(sessionId, viewerSessionToken)
    const state = viewerState(session, this.now().getTime())
    const segments = await this.store.getConfirmedSegments(sessionId, MAX_GHOSTRAIL_SEGMENTS)
    const points = segments.flatMap((segment) => segment.points).slice(-MAX_POINTS_PER_RESPONSE)
    return { state, points, segments, lastUpdate: session.lastReceivedAt }
  }

  async logoutViewer(sessionId: string, viewerSessionToken: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionId) || !/^[A-Za-z0-9_-]{43}$/.test(viewerSessionToken)) return
    const verifier = await capabilityVerifier(viewerSessionToken)
    await this.store.revokeViewerSession(sessionId, verifier, this.now().toISOString())
  }

  async rotateViewer(sessionId: string, emitterToken: string): Promise<{ viewerCapability: string; viewerGeneration: number }> {
    const session = await this.authorizeEmitter(sessionId, emitterToken)
    const now = this.now()
    if (stateAt(session, now.getTime()) !== 'active') throw new NativeSharingError(410, 'SESSION_INACTIVE', 'Session is not active.')
    const viewerToken = generateCapability()
    const updated = await this.store.rotateViewerCapability(sessionId, await capabilityVerifier(viewerToken), now.toISOString())
    if (!updated) throw new NativeSharingError(404, 'NOT_FOUND', 'Session was not found.')
    return { viewerCapability: buildViewerCapability(sessionId, viewerToken), viewerGeneration: updated.viewerGeneration }
  }

  async revoke(sessionId: string, emitterToken: string): Promise<void> {
    await this.authorizeEmitter(sessionId, emitterToken)
    const revoked = await this.store.revokeSession(sessionId, this.now().toISOString())
    if (!revoked) throw new NativeSharingError(404, 'NOT_FOUND', 'Session was not found.')
  }

  private async authorizeEmitter(sessionId: string, token: string): Promise<NativeSharingSession> {
    const session = await this.store.getSession(sessionId)
    if (!session || !(await verifyCapability(token, session.emitterVerifier))) throw new NativeSharingError(404, 'NOT_FOUND', 'Session was not found.')
    return session
  }

  private async authorizeViewerSession(sessionId: string, token: string): Promise<NativeSharingSession> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionId) || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new NativeSharingError(404, 'NOT_FOUND', 'Viewer session was not found.')
    }
    const session = await this.store.getSession(sessionId)
    if (!session) throw new NativeSharingError(404, 'NOT_FOUND', 'Viewer session was not found.')
    const viewerSession = await this.store.getViewerSession(sessionId, await capabilityVerifier(token))
    if (!viewerSession) throw new NativeSharingError(404, 'NOT_FOUND', 'Viewer session was not found.')

    const nowMs = this.now().getTime()
    const sharingState = stateAt(session, nowMs)
    if (sharingState !== 'active') {
      throw new NativeSharingError(410, sharingState === 'revoked' ? 'SESSION_REVOKED' : 'SESSION_EXPIRED', 'Session is no longer readable.')
    }
    if (viewerSession.revokedAt || viewerSession.viewerGeneration !== session.viewerGeneration) {
      throw new NativeSharingError(401, 'VIEWER_SESSION_INVALID', 'Viewer session is no longer valid.')
    }
    if (nowMs > Date.parse(viewerSession.expiresAt)) {
      throw new NativeSharingError(401, 'VIEWER_SESSION_EXPIRED', 'Viewer session has expired.')
    }
    return session
  }
}
