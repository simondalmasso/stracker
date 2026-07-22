import type {
  AcceptedNativePoint,
  AppendPointResult,
  CreateSessionInput,
  NativeSharingSegment,
  NativeSharingSession,
  NativeSharingStore,
} from './contracts.js'
import { DELETE_AFTER_EXPIRATION_MS, MAX_GHOSTRAIL_SEGMENTS } from './limits.js'

interface SessionBucket {
  session: NativeSharingSession
  points: AcceptedNativePoint[]
}

export class InMemoryNativeSharingStore implements NativeSharingStore {
  private readonly buckets = new Map<string, SessionBucket>()

  async createSession(input: CreateSessionInput): Promise<NativeSharingSession> {
    if (this.buckets.has(input.session.id)) throw new Error('SESSION_COLLISION')
    const session = structuredClone(input.session)
    this.buckets.set(session.id, { session, points: [] })
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

  async revokeSession(sessionId: string, revokedAt: string): Promise<NativeSharingSession | null> {
    const bucket = this.buckets.get(sessionId)
    if (!bucket) return null
    bucket.session = { ...bucket.session, state: 'revoked', revokedAt }
    return structuredClone(bucket.session)
  }

  async rotateViewerCapability(sessionId: string, verifier: string): Promise<NativeSharingSession | null> {
    const bucket = this.buckets.get(sessionId)
    if (!bucket || bucket.session.state !== 'active') return null
    bucket.session = { ...bucket.session, viewerVerifier: verifier, viewerGeneration: bucket.session.viewerGeneration + 1 }
    return structuredClone(bucket.session)
  }

  async deleteExpired(nowIso: string): Promise<number> {
    const now = Date.parse(nowIso)
    let deleted = 0
    for (const [sessionId, bucket] of this.buckets) {
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
  constructor(private readonly _database: D1DatabaseCandidate) {}
  private unavailable(): never { throw new Error('D1_NATIVE_SHARING_CANDIDATE_NOT_ENABLED') }
  async createSession(_input: CreateSessionInput) { return this.unavailable() }
  async getSession(_sessionId: string) { return this.unavailable() }
  async appendPoint(_sessionId: string, _expectedLastSequence: number, _point: AcceptedNativePoint) { return this.unavailable() }
  async getLatestPoint(_sessionId: string) { return this.unavailable() }
  async getConfirmedSegments(_sessionId: string, _maxSegments?: number) { return this.unavailable() }
  async revokeSession(_sessionId: string, _revokedAt: string) { return this.unavailable() }
  async rotateViewerCapability(_sessionId: string, _verifier: string) { return this.unavailable() }
  async deleteExpired(_nowIso: string) { return this.unavailable() }
}

export interface DurableObjectNativeSharingStubCandidate extends NativeSharingStore {}
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
  revokeSession(sessionId: string, revokedAt: string) { return this.stub().revokeSession(sessionId, revokedAt) }
  rotateViewerCapability(sessionId: string, verifier: string) { return this.stub().rotateViewerCapability(sessionId, verifier) }
  deleteExpired(nowIso: string) { return this.stub().deleteExpired(nowIso) }
}
