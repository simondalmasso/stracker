import type {
  AcceptedNativePoint,
  AppendPointResult,
  CreateSessionInput,
  NativeSharingSegment,
  NativeSharingSession,
  NativeSharingStore,
  OpaqueViewerSession,
} from './contracts.js'
import { DELETE_AFTER_EXPIRATION_MS, MAX_GHOSTRAIL_SEGMENTS } from './limits.js'

interface SessionBucket {
  session: NativeSharingSession
  points: AcceptedNativePoint[]
  viewerSessions: Map<string, OpaqueViewerSession>
}

export class InMemoryNativeSharingStore implements NativeSharingStore {
  private readonly buckets = new Map<string, SessionBucket>()

  async createSession(input: CreateSessionInput): Promise<NativeSharingSession> {
    if (this.buckets.has(input.session.id)) throw new Error('SESSION_COLLISION')
    const session = structuredClone(input.session)
    this.buckets.set(session.id, { session, points: [], viewerSessions: new Map() })
    return structuredClone(session)
  }

  async getSession(sessionId: string): Promise<NativeSharingSession | null> {
    const bucket = this.buckets.get(sessionId)
    return bucket ? structuredClone(bucket.session) : null
  }

  async appendPoint(sessionId: string, expectedLastSequence: number, point: AcceptedNativePoint): Promise<AppendPointResult> {
    const bucket = this.buckets.get(sessionId)
    if (!bucket) throw new Error('SESSION_NOT_FOUND')
    if (bucket.session.lastSequence !== expectedLastSequence) throw new Error('SEQUENCE_RACE')
    bucket.points.push(structuredClone(point))
    bucket.session = {
      ...bucket.session,
      lastSequence: point.sequence,
      lastCapturedAt: point.capturedAt,
      lastReceivedAt: point.receivedAt,
      pointCount: bucket.session.pointCount + 1,
    }
    return { session: structuredClone(bucket.session), point: structuredClone(point) }
  }

  async getLatestPoint(sessionId: string): Promise<AcceptedNativePoint | null> {
    const points = this.buckets.get(sessionId)?.points
    return points?.length ? structuredClone(points[points.length - 1]) : null
  }

  async getConfirmedSegments(sessionId: string, maxSegments = MAX_GHOSTRAIL_SEGMENTS): Promise<NativeSharingSegment[]> {
    const points = this.buckets.get(sessionId)?.points ?? []
    const segments: NativeSharingSegment[] = []
    let current: AcceptedNativePoint[] = []
    for (const point of points) {
      const prior = current[current.length - 1]
      if (prior && Date.parse(point.capturedAt) - Date.parse(prior.capturedAt) > 120_000) {
        if (current.length) segments.push(toSegment(sessionId, segments.length, current))
        current = []
      }
      current.push(point)
    }
    if (current.length) segments.push(toSegment(sessionId, segments.length, current))
    return structuredClone(segments.slice(-Math.max(1, Math.min(maxSegments, MAX_GHOSTRAIL_SEGMENTS))))
  }

  async createViewerSession(sessionId: string, viewerSession: OpaqueViewerSession): Promise<OpaqueViewerSession> {
    const bucket = this.buckets.get(sessionId)
    if (!bucket) throw new Error('SESSION_NOT_FOUND')
    bucket.viewerSessions.set(viewerSession.tokenVerifier, structuredClone(viewerSession))
    return structuredClone(viewerSession)
  }

  async getViewerSession(sessionId: string, tokenVerifier: string): Promise<OpaqueViewerSession | null> {
    const viewerSession = this.buckets.get(sessionId)?.viewerSessions.get(tokenVerifier)
    return viewerSession ? structuredClone(viewerSession) : null
  }

  async revokeViewerSession(sessionId: string, tokenVerifier: string, revokedAt: string): Promise<boolean> {
    const bucket = this.buckets.get(sessionId)
    const viewerSession = bucket?.viewerSessions.get(tokenVerifier)
    if (!bucket || !viewerSession) return false
    bucket.viewerSessions.set(tokenVerifier, { ...viewerSession, revokedAt })
    return true
  }

  async revokeAllViewerSessions(sessionId: string, revokedAt: string): Promise<number> {
    const bucket = this.buckets.get(sessionId)
    if (!bucket) return 0
    let revoked = 0
    for (const [verifier, viewerSession] of bucket.viewerSessions) {
      if (!viewerSession.revokedAt) {
        bucket.viewerSessions.set(verifier, { ...viewerSession, revokedAt })
        revoked += 1
      }
    }
    return revoked
  }

  async revokeSession(sessionId: string, revokedAt: string): Promise<NativeSharingSession | null> {
    const bucket = this.buckets.get(sessionId)
    if (!bucket) return null
    bucket.session = { ...bucket.session, state: 'revoked', revokedAt }
    await this.revokeAllViewerSessions(sessionId, revokedAt)
    return structuredClone(bucket.session)
  }

  async rotateViewerCapability(sessionId: string, verifier: string, revokedAt: string): Promise<NativeSharingSession | null> {
    const bucket = this.buckets.get(sessionId)
    if (!bucket || bucket.session.state !== 'active') return null
    await this.revokeAllViewerSessions(sessionId, revokedAt)
    bucket.session = { ...bucket.session, viewerVerifier: verifier, viewerGeneration: bucket.session.viewerGeneration + 1 }
    return structuredClone(bucket.session)
  }

  async deleteExpired(nowIso: string): Promise<number> {
    const now = Date.parse(nowIso)
    let deleted = 0
    for (const [sessionId, bucket] of this.buckets) {
      for (const [verifier, viewerSession] of bucket.viewerSessions) {
        if (viewerSession.revokedAt || now > Date.parse(viewerSession.expiresAt)) bucket.viewerSessions.delete(verifier)
      }
      if (now > Date.parse(bucket.session.expiresAt) + DELETE_AFTER_EXPIRATION_MS) {
        this.buckets.delete(sessionId)
        deleted += 1
      }
    }
    return deleted
  }
}

function toSegment(sessionId: string, index: number, points: AcceptedNativePoint[]): NativeSharingSegment {
  return {
    id: `${sessionId}:${index}`,
    points: structuredClone(points),
    startedAt: points[0].capturedAt,
    endedAt: points[points.length - 1].capturedAt,
  }
}

export interface D1DatabaseCandidate {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run<T = unknown>(): Promise<T>
      first<T = unknown>(): Promise<T | null>
      all<T = unknown>(): Promise<{ results?: T[] }>
    }
  }
  batch<T = unknown>(statements: unknown[]): Promise<T[]>
}

export class D1NativeSharingStoreCandidate implements NativeSharingStore {
  constructor(database: D1DatabaseCandidate) { void database }
  private unavailable(): never { throw new Error('D1_NATIVE_SHARING_CANDIDATE_NOT_ENABLED') }
  async createSession(input: CreateSessionInput) { void input; return this.unavailable() }
  async getSession(sessionId: string) { void sessionId; return this.unavailable() }
  async appendPoint(sessionId: string, expectedLastSequence: number, point: AcceptedNativePoint) { void sessionId; void expectedLastSequence; void point; return this.unavailable() }
  async getLatestPoint(sessionId: string) { void sessionId; return this.unavailable() }
  async getConfirmedSegments(sessionId: string, maxSegments?: number) { void sessionId; void maxSegments; return this.unavailable() }
  async createViewerSession(sessionId: string, viewerSession: OpaqueViewerSession) { void sessionId; void viewerSession; return this.unavailable() }
  async getViewerSession(sessionId: string, tokenVerifier: string) { void sessionId; void tokenVerifier; return this.unavailable() }
  async revokeViewerSession(sessionId: string, tokenVerifier: string, revokedAt: string) { void sessionId; void tokenVerifier; void revokedAt; return this.unavailable() }
  async revokeAllViewerSessions(sessionId: string, revokedAt: string) { void sessionId; void revokedAt; return this.unavailable() }
  async revokeSession(sessionId: string, revokedAt: string) { void sessionId; void revokedAt; return this.unavailable() }
  async rotateViewerCapability(sessionId: string, verifier: string, revokedAt: string) { void sessionId; void verifier; void revokedAt; return this.unavailable() }
  async deleteExpired(nowIso: string) { void nowIso; return this.unavailable() }
}

export type DurableObjectNativeSharingStubCandidate = NativeSharingStore
export interface DurableObjectNamespaceCandidate {
  getByName(name: string): DurableObjectNativeSharingStubCandidate
}

export class DurableObjectNativeSharingStoreCandidate implements NativeSharingStore {
  constructor(private readonly namespace: DurableObjectNamespaceCandidate, private readonly sessionId: string) {}
  private stub() { return this.namespace.getByName(this.sessionId) }
  createSession(input: CreateSessionInput) { return this.stub().createSession(input) }
  getSession(sessionId: string) { return this.stub().getSession(sessionId) }
  appendPoint(sessionId: string, expectedLastSequence: number, point: AcceptedNativePoint) { return this.stub().appendPoint(sessionId, expectedLastSequence, point) }
  getLatestPoint(sessionId: string) { return this.stub().getLatestPoint(sessionId) }
  getConfirmedSegments(sessionId: string, maxSegments?: number) { return this.stub().getConfirmedSegments(sessionId, maxSegments) }
  createViewerSession(sessionId: string, viewerSession: OpaqueViewerSession) { return this.stub().createViewerSession(sessionId, viewerSession) }
  getViewerSession(sessionId: string, tokenVerifier: string) { return this.stub().getViewerSession(sessionId, tokenVerifier) }
  revokeViewerSession(sessionId: string, tokenVerifier: string, revokedAt: string) { return this.stub().revokeViewerSession(sessionId, tokenVerifier, revokedAt) }
  revokeAllViewerSessions(sessionId: string, revokedAt: string) { return this.stub().revokeAllViewerSessions(sessionId, revokedAt) }
  revokeSession(sessionId: string, revokedAt: string) { return this.stub().revokeSession(sessionId, revokedAt) }
  rotateViewerCapability(sessionId: string, verifier: string, revokedAt: string) { return this.stub().rotateViewerCapability(sessionId, verifier, revokedAt) }
  deleteExpired(nowIso: string) { return this.stub().deleteExpired(nowIso) }
}
