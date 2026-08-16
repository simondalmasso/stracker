import type { CookieFormat, CookieProviderState, CookieSourceQuality } from './cookie-session.js'
import type { RuntimeSqlCursor, RuntimeSqlExecutor, RuntimeSqlRow } from './sqlite-store.js'

export type CookieDurableState = CookieProviderState | 'auth_expired'

export interface CookieSessionRecord {
  sessionId: string
  ownerVerifier: string
  ciphertext: string | null
  iv: string | null
  format: CookieFormat
  totalParsed: number
  expiredDropped: number
  invalidDropped: number
  retainedCount: number
  createdAt: string
  hardExpiresAt: string
  authExpiresAt: string | null
  validatedAt: string
  state: CookieDurableState
  lastProbeAt: string
  nextSampleAt: string | null
  consecutiveFailures: number
}

export interface CookieStoredPoint {
  id: number
  capturedAt: string
  observedAt: string
  lat: number
  lng: number
  accuracyM: number | null
  provenance: 'provider_observed'
  sourceQuality: CookieSourceQuality
}

export interface CookieStorageCounts {
  sessions: number
  points: number
  mobilityCells: number
  mobilityTransitions: number
}

type SessionRow = RuntimeSqlRow & {
  session_id: string
  owner_verifier: string
  cookie_ciphertext: string | null
  cookie_iv: string | null
  format: string
  total_parsed: number
  expired_dropped: number
  invalid_dropped: number
  retained_count: number
  created_at: string
  hard_expires_at: string
  auth_expires_at: string | null
  validated_at: string
  state: string
  last_probe_at: string
  next_sample_at: string | null
  consecutive_failures: number
}

type PointRow = RuntimeSqlRow & {
  id: number
  captured_at: string
  observed_at: string
  lat: number
  lng: number
  accuracy_m: number | null
  provenance: string
  source_quality: string
}

function one<T extends RuntimeSqlRow>(cursor: RuntimeSqlCursor<T>): T | null {
  return cursor.toArray()[0] ?? null
}

function count(cursor: RuntimeSqlCursor<RuntimeSqlRow & { count: number }>): number {
  return Number(one(cursor)?.count ?? 0)
}

function rowToSession(row: SessionRow): CookieSessionRecord {
  return {
    sessionId: row.session_id,
    ownerVerifier: row.owner_verifier,
    ciphertext: row.cookie_ciphertext,
    iv: row.cookie_iv,
    format: row.format as CookieFormat,
    totalParsed: Number(row.total_parsed),
    expiredDropped: Number(row.expired_dropped),
    invalidDropped: Number(row.invalid_dropped),
    retainedCount: Number(row.retained_count),
    createdAt: row.created_at,
    hardExpiresAt: row.hard_expires_at,
    authExpiresAt: row.auth_expires_at,
    validatedAt: row.validated_at,
    state: row.state as CookieDurableState,
    lastProbeAt: row.last_probe_at,
    nextSampleAt: row.next_sample_at,
    consecutiveFailures: Number(row.consecutive_failures),
  }
}

function rowToPoint(row: PointRow): CookieStoredPoint {
  return {
    id: Number(row.id),
    capturedAt: row.captured_at,
    observedAt: row.observed_at,
    lat: Number(row.lat),
    lng: Number(row.lng),
    accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
    provenance: 'provider_observed',
    sourceQuality: row.source_quality as CookieSourceQuality,
  }
}

export class SqliteCookieSessionStore {
  constructor(private readonly sql: RuntimeSqlExecutor) {}

  initializeSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS cookie_session (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      session_id TEXT NOT NULL UNIQUE CHECK (length(session_id) = 43),
      owner_verifier TEXT NOT NULL CHECK (length(owner_verifier) = 43),
      cookie_ciphertext TEXT,
      cookie_iv TEXT,
      format TEXT NOT NULL,
      total_parsed INTEGER NOT NULL CHECK (total_parsed >= 0),
      expired_dropped INTEGER NOT NULL CHECK (expired_dropped >= 0),
      invalid_dropped INTEGER NOT NULL CHECK (invalid_dropped >= 0),
      retained_count INTEGER NOT NULL CHECK (retained_count >= 0),
      created_at TEXT NOT NULL,
      hard_expires_at TEXT NOT NULL,
      auth_expires_at TEXT,
      validated_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('ready','no_location','auth_expired')),
      last_probe_at TEXT NOT NULL,
      next_sample_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0)
    )`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS cookie_location_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      lat REAL NOT NULL CHECK (lat >= -90 AND lat <= 90),
      lng REAL NOT NULL CHECK (lng >= -180 AND lng <= 180),
      accuracy_m REAL CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
      provenance TEXT NOT NULL CHECK (provenance = 'provider_observed'),
      source_quality TEXT NOT NULL CHECK (source_quality IN ('provider_timestamp','stracker_observed_at')),
      UNIQUE(captured_at, lat, lng)
    )`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS cookie_mobility_cells (
      cell_id TEXT NOT NULL,
      tod_bucket INTEGER NOT NULL CHECK (tod_bucket >= 0 AND tod_bucket <= 5),
      visits INTEGER NOT NULL CHECK (visits >= 1),
      dwell_ms INTEGER NOT NULL DEFAULT 0 CHECK (dwell_ms >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (cell_id, tod_bucket)
    )`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS cookie_mobility_transitions (
      from_cell TEXT NOT NULL,
      to_cell TEXT NOT NULL,
      tod_bucket INTEGER NOT NULL CHECK (tod_bucket >= 0 AND tod_bucket <= 5),
      traversal_count INTEGER NOT NULL CHECK (traversal_count >= 1),
      typical_duration_ms INTEGER NOT NULL CHECK (typical_duration_ms >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (from_cell, to_cell, tod_bucket)
    )`)
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_cookie_points_captured ON cookie_location_points(captured_at)')
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_cookie_points_observed ON cookie_location_points(observed_at)')
    this.sql.exec('CREATE INDEX IF NOT EXISTS idx_cookie_transitions_updated ON cookie_mobility_transitions(updated_at)')
  }

  putSession(record: CookieSessionRecord): void {
    this.sql.exec(
      `INSERT INTO cookie_session (
        singleton, session_id, owner_verifier, cookie_ciphertext, cookie_iv, format,
        total_parsed, expired_dropped, invalid_dropped, retained_count,
        created_at, hard_expires_at, auth_expires_at, validated_at, state,
        last_probe_at, next_sample_at, consecutive_failures
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        session_id=excluded.session_id,
        owner_verifier=excluded.owner_verifier,
        cookie_ciphertext=excluded.cookie_ciphertext,
        cookie_iv=excluded.cookie_iv,
        format=excluded.format,
        total_parsed=excluded.total_parsed,
        expired_dropped=excluded.expired_dropped,
        invalid_dropped=excluded.invalid_dropped,
        retained_count=excluded.retained_count,
        created_at=excluded.created_at,
        hard_expires_at=excluded.hard_expires_at,
        auth_expires_at=excluded.auth_expires_at,
        validated_at=excluded.validated_at,
        state=excluded.state,
        last_probe_at=excluded.last_probe_at,
        next_sample_at=excluded.next_sample_at,
        consecutive_failures=excluded.consecutive_failures`,
      record.sessionId,
      record.ownerVerifier,
      record.ciphertext,
      record.iv,
      record.format,
      record.totalParsed,
      record.expiredDropped,
      record.invalidDropped,
      record.retainedCount,
      record.createdAt,
      record.hardExpiresAt,
      record.authExpiresAt,
      record.validatedAt,
      record.state,
      record.lastProbeAt,
      record.nextSampleAt,
      record.consecutiveFailures,
    )
  }

  session(sessionId?: string): CookieSessionRecord | null {
    const row = sessionId
      ? one(this.sql.exec<SessionRow>('SELECT * FROM cookie_session WHERE session_id = ? LIMIT 1', sessionId))
      : one(this.sql.exec<SessionRow>('SELECT * FROM cookie_session WHERE singleton = 1 LIMIT 1'))
    return row ? rowToSession(row) : null
  }

  updateProbeState(sessionId: string, state: CookieProviderState, validatedAt: string, lastProbeAt: string, nextSampleAt: string): boolean {
    const cursor = this.sql.exec(
      `UPDATE cookie_session SET state = ?, validated_at = ?, last_probe_at = ?,
       next_sample_at = ?, consecutive_failures = 0
       WHERE session_id = ? AND cookie_ciphertext IS NOT NULL`,
      state,
      validatedAt,
      lastProbeAt,
      nextSampleAt,
      sessionId,
    )
    cursor.toArray()
    return this.sql.logicalRowsWritten() === 1
  }

  updateTransientFailure(sessionId: string, lastProbeAt: string, nextSampleAt: string, consecutiveFailures: number): boolean {
    const cursor = this.sql.exec(
      `UPDATE cookie_session SET last_probe_at = ?, next_sample_at = ?, consecutive_failures = ?
       WHERE session_id = ? AND cookie_ciphertext IS NOT NULL`,
      lastProbeAt,
      nextSampleAt,
      consecutiveFailures,
      sessionId,
    )
    cursor.toArray()
    return this.sql.logicalRowsWritten() === 1
  }

  markAuthExpired(sessionId: string, at: string): boolean {
    const cursor = this.sql.exec(
      `UPDATE cookie_session SET state = 'auth_expired', cookie_ciphertext = NULL, cookie_iv = NULL,
       validated_at = ?, last_probe_at = ?, next_sample_at = NULL
       WHERE session_id = ?`,
      at,
      at,
      sessionId,
    )
    cursor.toArray()
    return this.sql.logicalRowsWritten() === 1
  }

  deleteSessionData(sessionId: string): void {
    this.sql.transactionSync(() => {
      this.sql.exec('DELETE FROM cookie_location_points')
      this.sql.exec('DELETE FROM cookie_session WHERE session_id = ?', sessionId)
    })
  }

  insertObservedPoint(point: Omit<CookieStoredPoint, 'id'>): boolean {
    const cursor = this.sql.exec(
      `INSERT OR IGNORE INTO cookie_location_points (
        captured_at, observed_at, lat, lng, accuracy_m, provenance, source_quality
      ) VALUES (?, ?, ?, ?, ?, 'provider_observed', ?)`,
      point.capturedAt,
      point.observedAt,
      point.lat,
      point.lng,
      point.accuracyM,
      point.sourceQuality,
    )
    cursor.toArray()
    return this.sql.logicalRowsWritten() === 1
  }

  latestPoint(): CookieStoredPoint | null {
    const row = one(this.sql.exec<PointRow>('SELECT * FROM cookie_location_points ORDER BY captured_at DESC, id DESC LIMIT 1'))
    return row ? rowToPoint(row) : null
  }

  pointsSince(sinceIso: string): CookieStoredPoint[] {
    return this.sql.exec<PointRow>('SELECT * FROM cookie_location_points WHERE captured_at >= ? ORDER BY captured_at ASC, id ASC', sinceIso).toArray().map(rowToPoint)
  }

  pruneRawHistory(cutoffIso: string): number {
    const cursor = this.sql.exec('DELETE FROM cookie_location_points WHERE captured_at < ?', cutoffIso)
    cursor.toArray()
    return this.sql.logicalRowsWritten()
  }

  recordMobilityCell(cellId: string, todBucket: number, dwellMs: number, updatedAt: string): void {
    this.sql.exec(
      `INSERT INTO cookie_mobility_cells (cell_id, tod_bucket, visits, dwell_ms, updated_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(cell_id, tod_bucket) DO UPDATE SET
         visits = cookie_mobility_cells.visits + 1,
         dwell_ms = cookie_mobility_cells.dwell_ms + excluded.dwell_ms,
         updated_at = excluded.updated_at`,
      cellId,
      todBucket,
      Math.max(0, Math.floor(dwellMs)),
      updatedAt,
    )
  }

  recordMobilityTransition(fromCell: string, toCell: string, todBucket: number, durationMs: number, updatedAt: string): void {
    this.sql.exec(
      `INSERT INTO cookie_mobility_transitions (
        from_cell, to_cell, tod_bucket, traversal_count, typical_duration_ms, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(from_cell, to_cell, tod_bucket) DO UPDATE SET
        typical_duration_ms = CAST((cookie_mobility_transitions.typical_duration_ms * cookie_mobility_transitions.traversal_count + excluded.typical_duration_ms) /
          (cookie_mobility_transitions.traversal_count + 1) AS INTEGER),
        traversal_count = cookie_mobility_transitions.traversal_count + 1,
        updated_at = excluded.updated_at`,
      fromCell,
      toCell,
      todBucket,
      Math.max(0, Math.floor(durationMs)),
      updatedAt,
    )
  }

  transitionPrior(fromCell: string, toCell: string, todBucket: number): { count: number; typicalDurationMs: number } {
    const row = one(this.sql.exec<RuntimeSqlRow & { traversal_count: number; typical_duration_ms: number }>(
      `SELECT traversal_count, typical_duration_ms FROM cookie_mobility_transitions
       WHERE from_cell = ? AND to_cell = ? AND tod_bucket = ? LIMIT 1`,
      fromCell,
      toCell,
      todBucket,
    ))
    return { count: Number(row?.traversal_count ?? 0), typicalDurationMs: Number(row?.typical_duration_ms ?? 0) }
  }

  pruneMobility(cutoffIso: string): void {
    this.sql.exec('DELETE FROM cookie_mobility_cells WHERE updated_at < ?', cutoffIso)
    this.sql.exec('DELETE FROM cookie_mobility_transitions WHERE updated_at < ?', cutoffIso)
  }

  clearMobility(): void {
    this.sql.transactionSync(() => {
      this.sql.exec('DELETE FROM cookie_mobility_cells')
      this.sql.exec('DELETE FROM cookie_mobility_transitions')
    })
  }

  effectiveSessionDeadlineMs(): number | null {
    const current = this.session()
    if (!current) return null
    const hard = Date.parse(current.hardExpiresAt)
    if (current.state === 'auth_expired') return hard
    const auth = current.authExpiresAt ? Date.parse(current.authExpiresAt) : Number.POSITIVE_INFINITY
    return Math.min(hard, auth)
  }

  nextAlarmAtMs(): number | null {
    const current = this.session()
    if (!current) return null
    const deadline = this.effectiveSessionDeadlineMs()
    if (current.state === 'auth_expired') return deadline
    const sample = current.nextSampleAt ? Date.parse(current.nextSampleAt) : Number.POSITIVE_INFINITY
    const next = Math.min(deadline ?? Number.POSITIVE_INFINITY, sample)
    return Number.isFinite(next) ? next : null
  }

  storageCounts(): CookieStorageCounts {
    return {
      sessions: count(this.sql.exec<RuntimeSqlRow & { count: number }>('SELECT COUNT(*) AS count FROM cookie_session')),
      points: count(this.sql.exec<RuntimeSqlRow & { count: number }>('SELECT COUNT(*) AS count FROM cookie_location_points')),
      mobilityCells: count(this.sql.exec<RuntimeSqlRow & { count: number }>('SELECT COUNT(*) AS count FROM cookie_mobility_cells')),
      mobilityTransitions: count(this.sql.exec<RuntimeSqlRow & { count: number }>('SELECT COUNT(*) AS count FROM cookie_mobility_transitions')),
    }
  }
}
