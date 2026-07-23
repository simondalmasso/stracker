import type {
  AcceptedNativePoint,
  AppendPointResult,
  CreateSessionInput,
  NativeSharingSegment,
  NativeSharingSession,
  NativeSharingStore,
  OpaqueViewerSession,
  ViewerSessionCreationExpectation,
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
export interface RuntimeSqlCursor<T extends RuntimeSqlRow> {
  readonly rowsRead: number
  readonly rowsWritten: number
  toArray(): T[]
}
export interface RuntimeSqlExecutor {
  exec<T extends RuntimeSqlRow = RuntimeSqlRow>(query: string, ...bindings: RuntimeSqlValue[]): RuntimeSqlCursor<T>
  transactionSync<T>(callback: () => T): T
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

export interface NativeSharingStorageCounts {
  sessions: number
  points: number
  viewers: number
  sequenceStates: number
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

function count(cursor: RuntimeSqlCursor<RuntimeSqlRow & { count: number }>): number {
  return Number(one(cursor)?.count ?? 0)
}

function completedRowsWritten(cursor: RuntimeSqlCursor<RuntimeSqlRow>): number {
  cursor.toArray()
  return cursor.rowsWritten
}

export class SqliteNativeSharingStore implements NativeSharingStore {
  constructor(private readonly sql: RuntimeSqlExecutor) {}

  initializeSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sharing_session (
      id TEXT PRIMARY KEY CHECK (length(id) = 43),
      singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
      emitter_verifier TEXT NOT NULL UNIQUE CHECK (length(emitter_verifier) = 43),
      viewer_verifier TEXT NOT NULL UNIQUE CHECK (length(viewer_verifier) = 43),
      viewer_generation INTEGER NOT NULL CHECK (viewer_generation >= 1),
      state TEXT NOT NULL CHECK (state IN ('active','revoked','expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
      last_captured_at TEXT,
      last_received_at TEXT,
      point_count INTEGER NOT NULL DEFAULT 0 CHECK (point_count >= 0)
    )`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS accepted_points (
      sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
      lat REAL NOT NULL CHECK (lat >= -90 AND lat <= 90),
      lng REAL NOT NULL CHECK (lng >= -180 AND lng <= 180),
      accuracy_m REAL CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
      speed_mps REAL CHECK (speed_mps IS NULL OR speed_mps >= 0),
      heading_deg REAL CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg < 360)),
      captured_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      segment_index INTEGER NOT NULL CHECK (segment_index >= 0)
    )`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS viewer_sessions (
      token_verifier TEXT PRIMARY KEY CHECK (length(token_verifier) = 43),
      sharing_session_id TEXT NOT NULL CHECK (length(sharing_session_id) = 43),
      viewer_generation INTEGER NOT NULL CHECK (viewer_generation >= 1),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
    )`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rate_or_sequence_state (
      state_key TEXT PRIMARY KEY CHECK (state_key = 'point-sequence'),
      last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
      updated_at TEXT NOT NULL
    )`)
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_accepted_points_segment_sequence ON accepted_points(segment_index, sequence)')
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_accepted_points_sequence ON accepted_points(sequence)')
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_viewer_active ON viewer_sessions(viewer_generation, revoked_at, expires_at)')
  }

  async createSession(input: CreateSessionInput): Promise<NativeSharingSession> {
    return this.sql.transactionSync(() => {
      if (one(this.sql.exec<SessionRow>('SELECT * FROM sharing_session LIMIT 1'))) {
        throw new NativeSharingStoreFault('SESSION_COLLISION')
      }
      const session = input.session
      const inserted = this.sql.exec(
        `INSERT INTO sharing_session (
          id, singleton, emitter_verifier, viewer_verifier, viewer_generation, state,
          created_at, expires_at, revoked_at, last_sequence, last_captured_at,
          last_received_at, point_count
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      if (completedRowsWritten(inserted) !== 1) throw new NativeSharingStoreFault('SESSION_CREATE_FAILED')
      const sequenceState = this.sql.exec(
        `INSERT INTO rate_or_sequence_state (state_key, last_sequence, updated_at)
         VALUES ('point-sequence', ?, ?)`,
        session.lastSequence,
        session.createdAt,
      )
      if (completedRowsWritten(sequenceState) !== 1) throw new NativeSharingStoreFault('SESSION_CREATE_FAILED')
      return structuredClone(session)
    })
  }

  async getSession(sessionId: string): Promise<NativeSharingSession | null> {
    const row = one(this.sql.exec<SessionRow>('SELECT * FROM sharing_session WHERE id = ? LIMIT 1', sessionId))
    return row ? toSession(row) : null
  }

  async appendPoint(sessionId: string, expectedLastSequence: number, point: AcceptedNativePoint): Promise<AppendPointResult> {
    return this.sql.transactionSync(() => {
      const row = one(this.sql.exec<SessionRow>('SELECT * FROM sharing_session WHERE id = ? LIMIT 1', sessionId))
      if (!row) throw new NativeSharingStoreFault('SESSION_NOT_FOUND')
      const session = toSession(row)
      if (session.state !== 'active' || Date.parse(point.receivedAt) > Date.parse(session.expiresAt)) {
        throw new NativeSharingStoreFault('SESSION_INACTIVE')
      }
      if (session.lastSequence !== expectedLastSequence || point.sequence <= session.lastSequence) {
        throw new NativeSharingStoreFault('SEQUENCE_RACE')
      }
      if (session.pointCount >= MAX_POINTS_PER_SESSION) throw new NativeSharingStoreFault('POINT_QUOTA_EXCEEDED')

      const previous = one(this.sql.exec<PointRow>('SELECT * FROM accepted_points ORDER BY sequence DESC LIMIT 1'))
      const segmentIndex = previous
        ? previous.segment_index + (Date.parse(point.capturedAt) - Date.parse(previous.captured_at) > SEGMENT_GAP_MS ? 1 : 0)
        : 0

      const updated = this.sql.exec(
        `UPDATE sharing_session SET
          last_sequence = ?, last_captured_at = ?, last_received_at = ?, point_count = point_count + 1
         WHERE id = ? AND state = 'active' AND expires_at >= ?
           AND last_sequence = ? AND point_count < ?`,
        point.sequence,
        point.capturedAt,
        point.receivedAt,
        sessionId,
        point.receivedAt,
        expectedLastSequence,
        MAX_POINTS_PER_SESSION,
      )
      if (completedRowsWritten(updated) !== 1) throw new NativeSharingStoreFault('SEQUENCE_RACE')

      const sequenceUpdated = this.sql.exec(
        `UPDATE rate_or_sequence_state SET last_sequence = ?, updated_at = ?
         WHERE state_key = 'point-sequence' AND last_sequence = ?`,
        point.sequence,
        point.receivedAt,
        expectedLastSequence,
      )
      if (completedRowsWritten(sequenceUpdated) !== 1) throw new NativeSharingStoreFault('SEQUENCE_RACE')

      const inserted = this.sql.exec(
        `INSERT INTO accepted_points (
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
      if (completedRowsWritten(inserted) !== 1) throw new NativeSharingStoreFault('POINT_INSERT_FAILED')

      const updatedRow = one(this.sql.exec<SessionRow>('SELECT * FROM sharing_session WHERE id = ? LIMIT 1', sessionId))
      if (!updatedRow) throw new NativeSharingStoreFault('SESSION_NOT_FOUND')
      return { session: toSession(updatedRow), point: structuredClone(point) }
    })
  }

  async getLatestPoint(sessionId: string): Promise<AcceptedNativePoint | null> {
    const row = one(this.sql.exec<PointRow>('SELECT * FROM accepted_points ORDER BY sequence DESC LIMIT 1'))
    return row ? toPoint(sessionId, row) : null
  }

  async getConfirmedSegments(sessionId: string, maxSegments = MAX_GHOSTRAIL_SEGMENTS): Promise<NativeSharingSegment[]> {
    const rows = this.sql.exec<PointRow>('SELECT * FROM accepted_points ORDER BY sequence DESC LIMIT ?', MAX_POINTS_RETURNED).toArray().reverse()
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

  async createViewerSession(
    sessionId: string,
    viewerSession: OpaqueViewerSession,
    expectation: ViewerSessionCreationExpectation,
  ): Promise<OpaqueViewerSession> {
    return this.sql.transactionSync(() => {
      const row = one(this.sql.exec<SessionRow>('SELECT * FROM sharing_session WHERE id = ? LIMIT 1', sessionId))
      if (
        !row ||
        expectation.sessionId !== sessionId ||
        row.id !== sessionId ||
        row.state !== 'active' ||
        Date.parse(row.expires_at) <= Date.parse(expectation.nowIso) ||
        row.viewer_verifier !== expectation.expectedViewerVerifier ||
        row.viewer_generation !== expectation.expectedViewerGeneration ||
        viewerSession.sharingSessionId !== sessionId ||
        viewerSession.viewerGeneration !== expectation.expectedViewerGeneration
      ) {
        throw new NativeSharingStoreFault('VIEWER_GENERATION_RACE')
      }

      this.sql.exec('DELETE FROM viewer_sessions WHERE revoked_at IS NOT NULL OR expires_at <= ?', expectation.nowIso)
      const active = count(this.sql.exec<RuntimeSqlRow & { count: number }>(
        `SELECT COUNT(*) AS count FROM viewer_sessions
         WHERE viewer_generation = ? AND revoked_at IS NULL AND expires_at > ?`,
        expectation.expectedViewerGeneration,
        expectation.nowIso,
      ))
      if (active >= MAX_ACTIVE_VIEWER_SESSIONS) throw new NativeSharingStoreFault('VIEWER_SESSION_QUOTA_EXCEEDED')
      const inserted = this.sql.exec(
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
      if (completedRowsWritten(inserted) !== 1) throw new NativeSharingStoreFault('VIEWER_SESSION_CREATE_FAILED')
      return structuredClone(viewerSession)
    })
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
    const updated = this.sql.exec(
      `UPDATE viewer_sessions SET revoked_at = COALESCE(revoked_at, ?)
       WHERE sharing_session_id = ? AND token_verifier = ?`,
      revokedAt,
      sessionId,
      tokenVerifier,
    )
    return completedRowsWritten(updated) === 1
  }

  async revokeAllViewerSessions(sessionId: string, revokedAt: string): Promise<number> {
    const updated = this.sql.exec(
      'UPDATE viewer_sessions SET revoked_at = ? WHERE sharing_session_id = ? AND revoked_at IS NULL',
      revokedAt,
      sessionId,
    )
    return completedRowsWritten(updated)
  }

  async revokeSession(sessionId: string, revokedAt: string): Promise<NativeSharingSession | null> {
    return this.sql.transactionSync(() => {
      const session = one(this.sql.exec<SessionRow>('SELECT * FROM sharing_session WHERE id = ? LIMIT 1', sessionId))
      if (!session) return null
      const updated = this.sql.exec(
        `UPDATE sharing_session SET state = 'revoked', revoked_at = COALESCE(revoked_at, ?)
         WHERE id = ?`,
        revokedAt,
        sessionId,
      )
      if (completedRowsWritten(updated) !== 1) throw new NativeSharingStoreFault('SESSION_REVOKE_FAILED')
      this.sql.exec(
        'UPDATE viewer_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE sharing_session_id = ? AND revoked_at IS NULL',
        revokedAt,
        sessionId,
      )
      const result = one(this.sql.exec<SessionRow>('SELECT * FROM sharing_session WHERE id = ? LIMIT 1', sessionId))
      return result ? toSession(result) : null
    })
  }

  async rotateViewerCapability(sessionId: string, verifier: string, revokedAt: string): Promise<NativeSharingSession | null> {
    return this.sql.transactionSync(() => {
      const row = one(this.sql.exec<SessionRow>('SELECT * FROM sharing_session WHERE id = ? LIMIT 1', sessionId))
      if (!row || row.state !== 'active') return null
      const updated = this.sql.exec(
        `UPDATE sharing_session
         SET viewer_verifier = ?, viewer_generation = viewer_generation + 1
         WHERE id = ? AND state = 'active' AND viewer_generation = ?`,
        verifier,
        sessionId,
        row.viewer_generation,
      )
      if (completedRowsWritten(updated) !== 1) throw new NativeSharingStoreFault('VIEWER_ROTATION_RACE')
      this.sql.exec(
        'UPDATE viewer_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE sharing_session_id = ? AND revoked_at IS NULL',
        revokedAt,
        sessionId,
      )
      const result = one(this.sql.exec<SessionRow>('SELECT * FROM sharing_session WHERE id = ? LIMIT 1', sessionId))
      return result ? toSession(result) : null
    })
  }

  async deleteExpired(nowIso: string): Promise<number> {
    return this.sql.transactionSync(() => {
      this.sql.exec('DELETE FROM viewer_sessions WHERE revoked_at IS NOT NULL OR expires_at <= ?', nowIso)
      const session = one(this.sql.exec<SessionRow>('SELECT * FROM sharing_session LIMIT 1'))
      if (!session) return 0
      const deadline = Date.parse(session.expires_at) + DELETE_AFTER_EXPIRATION_MS
      if (Date.parse(nowIso) < deadline) return 0
      this.sql.exec('DELETE FROM viewer_sessions')
      this.sql.exec('DELETE FROM accepted_points')
      this.sql.exec('DELETE FROM rate_or_sequence_state')
      this.sql.exec('DELETE FROM sharing_session')
      return 1
    })
  }

  deletionDeadlineMs(): number | null {
    const session = one(this.sql.exec<SessionRow>('SELECT * FROM sharing_session LIMIT 1'))
    return session ? Date.parse(session.expires_at) + DELETE_AFTER_EXPIRATION_MS : null
  }

  storageCounts(): NativeSharingStorageCounts {
    return {
      sessions: count(this.sql.exec<RuntimeSqlRow & { count: number }>('SELECT COUNT(*) AS count FROM sharing_session')),
      points: count(this.sql.exec<RuntimeSqlRow & { count: number }>('SELECT COUNT(*) AS count FROM accepted_points')),
      viewers: count(this.sql.exec<RuntimeSqlRow & { count: number }>('SELECT COUNT(*) AS count FROM viewer_sessions')),
      sequenceStates: count(this.sql.exec<RuntimeSqlRow & { count: number }>('SELECT COUNT(*) AS count FROM rate_or_sequence_state')),
    }
  }
}
