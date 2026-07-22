import type {
  AcceptedNativePoint,
  CreateSessionResponse,
  NativeSharedLocationPoint,
  NativeSharingSession,
  NativeSharingStore,
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
} from './limits.js'
import { buildViewerCapability, capabilityVerifier, generateCapability, verifyCapability } from './security.js'

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
  const current = stateAt(session, nowMs)
  if (current === 'revoked') return 'revoked'
  if (current === 'expired') return 'expired'
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

  async getStatus(sessionId: string, viewerToken: string): Promise<ViewerStatusResponse> {
    const session = await this.authorizeViewer(sessionId, viewerToken)
    return {
      state: viewerState(session, this.now().getTime()),
      expiresAt: session.expiresAt,
      lastUpdate: session.lastReceivedAt,
      pointCount: session.pointCount,
    }
  }

  async getPoints(sessionId: string, viewerToken: string): Promise<ViewerPointsResponse> {
    const session = await this.authorizeViewer(sessionId, viewerToken)
    const state = viewerState(session, this.now().getTime())
    if (state === 'expired' || state === 'revoked') throw new NativeSharingError(410, state === 'revoked' ? 'SESSION_REVOKED' : 'SESSION_EXPIRED', 'Session is no longer readable.')
    const segments = await this.store.getConfirmedSegments(sessionId, MAX_GHOSTRAIL_SEGMENTS)
    const points = segments.flatMap((segment) => segment.points).slice(-MAX_POINTS_PER_RESPONSE)
    return { state, points, segments, lastUpdate: session.lastReceivedAt }
  }

  async rotateViewer(sessionId: string, emitterToken: string): Promise<{ viewerCapability: string; viewerGeneration: number }> {
    const session = await this.authorizeEmitter(sessionId, emitterToken)
    if (stateAt(session, this.now().getTime()) !== 'active') throw new NativeSharingError(410, 'SESSION_INACTIVE', 'Session is not active.')
    const viewerToken = generateCapability()
    const updated = await this.store.rotateViewerCapability(sessionId, await capabilityVerifier(viewerToken))
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

  private async authorizeViewer(sessionId: string, token: string): Promise<NativeSharingSession> {
    const session = await this.store.getSession(sessionId)
    if (!session || !(await verifyCapability(token, session.viewerVerifier))) throw new NativeSharingError(404, 'NOT_FOUND', 'Session was not found.')
    return session
  }
}
