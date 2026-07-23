import type {
  AcceptedNativePoint,
  AppendPointResult,
  CreateSessionInput,
  NativeSharingSegment,
  NativeSharingSession,
  NativeSharingStore,
  OpaqueViewerSession,
} from '../../native-sharing/src/contracts.js'
import {
  DELETE_AFTER_EXPIRATION_MS,
  MAX_ACTIVE_VIEWER_SESSIONS,
  MAX_GHOSTRAIL_SEGMENTS,
  MAX_POINTS_PER_SESSION,
  MAX_POINTS_RETURNED,
  SEGMENT_GAP_MS,
} from './runtime-limits.js'

export type RuntimeSqlValue = ArrayBuffer | string | number | null
export interface RuntimeSqlRow { [column: string]: RuntimeSqlValue }
export interface RuntimeSqlCursor<T extends RuntimeSqlRow> { toArray(): T[] }
export interface RuntimeSqlExecutor {
  exec<T extends RuntimeSqlRow = RuntimeSqlRow>(query: string, ...bindings: RuntimeSqlValue[]): RuntimeSqlCursor<T>
}

export class NativeSharingStoreFault extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'NativeSharingStoreFault'
  }
}

type SessionRow = RuntimeSqlRow & {
  id: string
  emitter_verifier: string
  viewer_verifier: string
  viewer_generation: number
  state: string
  created_at: string
  expires_at: string
  revoked_at: string | null
  last_sequence: number
  last_captured_at: string | null
  last_received_at: string | null
  point_count: number
}

type PointRow = RuntimeSqlRow & {
  sequence: number
  lat: number
  lng: number
  accuracy_m: number | null
  speed_mps: number | null
  heading_deg: number | null
  captured_at: string
  received_at: string
  segment_index: number
}

type ViewerRow = RuntimeSqlRow & {
  token_verifier: string
  sharing_session_id: string
  viewer_generation: number
  created_at: string
  expires_at: string
  revoked_at: string | null
}

function one<T extends RuntimeSqlRow>(cursor: RuntimeSqlCursor<T>): T | null {
  return cursor.toArray()[0] ?? null
}

function toSession(row: SessionRow): NativeSharingSession {
  return {
    id: row.id,
    emitterVerifier: row.emitter_verifier,
    viewerVerifier: row.viewer_verifier,
    viewerGeneration: row.viewer_generation,
    state: row.state as NativeSharingSession['state'],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastSequence: row.last_sequence,
    lastCapturedAt: row.last_captured_at,
    lastReceivedAt: row.last_received_at,
    pointCount: row.point_count,
  }
}

function toPoint(sessionId: string, row: PointRow): AcceptedNativePoint {
  return {
    version: 1,
    sequence: row.sequence,
    lat: row.lat,
    lng: row.lng,
    accuracyM: row.accuracy_m,
    speedMps: row.speed_mps,
    headingDeg: row.heading_deg,
    capturedAt: row.captured_at,
    receivedAt: row.received_at,
    sessionId,
    acceptanceState: 'accepted',
  }
}

function toViewer(row: ViewerRow): OpaqueViewerSession {
  return {
    tokenVerifier: row.token_verifier,
    sharingSessionId: row.sharing_session_id,
    viewerGeneration: row.viewer_generation,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  }
}

export class SqliteNativeSharingStore implements NativeSharingStore {
  constructor(private readonly sql: RuntimeSqlExecutor) {}

  initializeSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sharing_session (
      id TEXT PRIMARY KEY,
      emitter_verifier TEXT NOT NULL,
      viewer_verifier TEXT NOT NULL,
      viewer_generation INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active','revoked','expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      last_sequence INTEGER NOT NULL DEFAULT 0,
      last_captured_at TEXT,
      last_received_at TEXT,
      point_count INTEGER NOT NULL DEFAULT 0
    )`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS points (
      sequence INTEGER PRIMARY KEY,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      accuracy_m REAL,
      speed_mps REAL,
      heading_deg REAL,
      captured_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      segment_index INTEGER NOT NULL
    )`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS viewer_sessions (
      token_verifier TEXT PRIMARY KEY,
      sharing_session_id TEXT NOT NULL,
      viewer_generation INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    )`)
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_points_segment_sequence ON points(segment_index, sequence)')
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_viewer_generation_expiry ON viewer_sessions(viewer_generation, expires_at)')
  }

  async createSession(input: CreateSessionInput): Promise<NativeSharingSession> {
    if (one(this.sql.exec<SessionRow>('SELECT * FROM sharing_session LIMIT 1'))) {
      throw new NativeSharingStoreFault('SESSION_COLLISION')
    }
    const session = input.session
    this.sql.exec(
      `INSERT INTO sharing_session (
        id, emitter_verifier, viewer_verifier, viewer_generation, state,
        created_at, expires_at, revoked_at, last_sequence, last_captured_at,
        last_received_at, point_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      session.id,
      session.emitterVerifier,
      session.viewerVerifier,
      session.viewerGeneration,
      session.state,
      session.createdAt,
      session.expiresAt,
      session.revokedAt,
      session.lastSequence,
      session.lastCapturedAt,
      session.lastReceivedAt,
      session.pointCount,
    )
    return structuredClone(session)
  }

  async getSession(sessionId: string): Promise<NativeSharingSession | null> {
    const row = one(this.sql.exec<SessionRow>('SELECT * FROM sharing_session WHERE id = ? LIMIT 1', sessionId))
    return row ? toSession(row) : null
  }

  async appendPoint(sessionId: string, expectedLastSequence: number, point: AcceptedNativePoint): Promise<AppendPointResult> {
    const session = await this.getSession(sessionId)
    if (!session) throw new NativeSharingStoreFault('SESSION_NOT_FOUND')
    if (session.lastSequence !== expectedLastSequence) throw new NativeSharingStoreFault('SEQUENCE_RACE')
    if (session.pointCount >= MAX_POINTS_PER_SESSION) throw new NativeSharingStoreFault('POINT_QUOTA_EXCEEDED')

    const previous = one(this.sql.exec<PointRow>('SELECT * FROM points ORDER BY sequence DESC LIMIT 1'))
    const segmentIndex = previous
      ? previous.segment_index + (Date.parse(point.capturedAt) - Date.parse(previous.captured_at) > SEGMENT_GAP_MS ? 1 : 0)
      : 0

    this.sql.exec(
      `INSERT INTO points (
        sequence, lat, lng, accuracy_m, speed_mps, heading_deg,
        captured_at, received_at, segment_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      point.sequence,
      point.lat,
      point.lng,
      point.accuracyM,
      point.speedMps,
      point.headingDeg,
      point.capturedAt,
      point.receivedAt,
      segmentIndex,
    )
    this.sql.exec(
      `UPDATE sharing_session SET
        last_sequence = ?, last_captured_at = ?, last_received_at = ?, point_count = point_count + 1
       WHERE id = ? AND last_sequence = ?`,
      point.sequence,
      point.capturedAt,
      point.receivedAt,
      sessionId,
      expectedLastSequence,
    )
    const updated = await this.getSession(sessionId)
    if (!updated || updated.lastSequence !== point.sequence) throw new NativeSharingStoreFault('SEQUENCE_RACE')
    return { session: updated, point: structuredClone(point) }
  }

  async getLatestPoint(sessionId: string): Promise<AcceptedNativePoint | null> {
    const row = one(this.sql.exec<PointRow>('SELECT * FROM points ORDER BY sequence DESC LIMIT 1'))
    return row ? toPoint(sessionId, row) : null
  }

  async getConfirmedSegments(sessionId: string, maxSegments = MAX_GHOSTRAIL_SEGMENTS): Promise<NativeSharingSegment[]> {
    const rows = this.sql.exec<PointRow>('SELECT * FROM points ORDER BY sequence DESC LIMIT ?', MAX_POINTS_RETURNED).toArray().reverse()
    const grouped = new Map<number, AcceptedNativePoint[]>()
    for (const row of rows) {
      const list = grouped.get(row.segment_index) ?? []
      list.push(toPoint(sessionId, row))
      grouped.set(row.segment_index, list)
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => left - right)
      .slice(-Math.max(1, Math.min(maxSegments, MAX_GHOSTRAIL_SEGMENTS)))
      .map(([segmentIndex, points]) => ({
        id: `${sessionId}:${segmentIndex}`,
        points,
        startedAt: points[0].capturedAt,
        endedAt: points[points.length - 1].capturedAt,
      }))
  }

  async createViewerSession(sessionId: string, viewerSession: OpaqueViewerSession): Promise<OpaqueViewerSession> {
    this.sql.exec('DELETE FROM viewer_sessions WHERE revoked_at IS NOT NULL OR expires_at <= ?', viewerSession.createdAt)
    const countRow = one(this.sql.exec<RuntimeSqlRow & { count: number }>(
      'SELECT COUNT(*) AS count FROM viewer_sessions WHERE viewer_generation = ? AND revoked_at IS NULL AND expires_at > ?',
      viewerSession.viewerGeneration,
      viewerSession.createdAt,
    ))
    if ((countRow?.count ?? 0) >= MAX_ACTIVE_VIEWER_SESSIONS) {
      throw new NativeSharingStoreFault('VIEWER_SESSION_QUOTA_EXCEEDED')
    }
    this.sql.exec(
      `INSERT INTO viewer_sessions (
        token_verifier, sharing_session_id, viewer_generation, created_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      viewerSession.tokenVerifier,
      sessionId,
      viewerSession.viewerGeneration,
      viewerSession.createdAt,
      viewerSession.expiresAt,
      viewerSession.revokedAt,
    )
    return structuredClone(viewerSession)
  }

  async getViewerSession(sessionId: string, tokenVerifier: string): Promise<OpaqueViewerSession | null> {
    const row = one(this.sql.exec<ViewerRow>(
      'SELECT * FROM viewer_sessions WHERE sharing_session_id = ? AND token_verifier = ? LIMIT 1',
      sessionId,
      tokenVerifier,
    ))
    return row ? toViewer(row) : null
  }

  async revokeViewerSession(sessionId: string, tokenVerifier: string, revokedAt: string): Promise<boolean> {
    const existing = await this.getViewerSession(sessionId, tokenVerifier)
    if (!existing) return false
    this.sql.exec(
      'UPDATE viewer_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE sharing_session_id = ? AND token_verifier = ?',
      revokedAt,
      sessionId,
      tokenVerifier,
    )
    return true
  }

  async revokeAllViewerSessions(sessionId: string, revokedAt: string): Promise<number> {
    const rows = this.sql.exec<ViewerRow>(
      'SELECT * FROM viewer_sessions WHERE sharing_session_id = ? AND revoked_at IS NULL',
      sessionId,
    ).toArray()
    this.sql.exec(
      'UPDATE viewer_sessions SET revoked_at = ? WHERE sharing_session_id = ? AND revoked_at IS NULL',
      revokedAt,
      sessionId,
    )
    return rows.length
  }

  async revokeSession(sessionId: string, revokedAt: string): Promise<NativeSharingSession | null> {
    const session = await this.getSession(sessionId)
    if (!session) return null
    this.sql.exec('UPDATE sharing_session SET state = ?, revoked_at = ? WHERE id = ?', 'revoked', revokedAt, sessionId)
    await this.revokeAllViewerSessions(sessionId, revokedAt)
    return this.getSession(sessionId)
  }

  async rotateViewerCapability(sessionId: string, verifier: string, revokedAt: string): Promise<NativeSharingSession | null> {
    const session = await this.getSession(sessionId)
    if (!session || session.state !== 'active') return null
    await this.revokeAllViewerSessions(sessionId, revokedAt)
    this.sql.exec(
      'UPDATE sharing_session SET viewer_verifier = ?, viewer_generation = viewer_generation + 1 WHERE id = ?',
      verifier,
      sessionId,
    )
    return this.getSession(sessionId)
  }

  async deleteExpired(nowIso: string): Promise<number> {
    this.sql.exec('DELETE FROM viewer_sessions WHERE revoked_at IS NOT NULL OR expires_at <= ?', nowIso)
    const session = one(this.sql.exec<SessionRow>('SELECT * FROM sharing_session LIMIT 1'))
    if (!session) return 0
    if (Date.parse(nowIso) <= Date.parse(session.expires_at) + DELETE_AFTER_EXPIRATION_MS) return 0
    this.sql.exec('DELETE FROM viewer_sessions')
    this.sql.exec('DELETE FROM points')
    this.sql.exec('DELETE FROM sharing_session')
    return 1
  }
}
