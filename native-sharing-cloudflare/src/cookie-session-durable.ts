import { capabilityVerifier } from '../../native-sharing/src/security.js'
import {
  COOKIE_HISTORY_WINDOW_MS,
  COOKIE_MOBILITY_RETENTION_MS,
  COOKIE_REFRESH_MIN_INTERVAL_MS,
  COOKIE_SAMPLE_INTERVAL_MS,
  COOKIE_POLICY_VERSION,
  MAX_COOKIE_SESSION_DURATION_MS,
  MIN_COOKIE_SESSION_DURATION_MS,
  CookieContractError,
  parseCookieSession,
  probeGoogleCookieSession,
  type CookiePoint,
  type CookieProbe,
  type CookieProviderState,
  type CookieSessionImportInput,
  type CookieSessionPointResponse,
  type CookieSessionPublicStatus,
  type CookieSourceQuality,
  type NormalizedCookie,
} from './cookie-session.js'
import { SqliteCookieSessionStore, type CookieSessionRecord, type CookieStoredPoint } from './cookie-session-store.js'
import type { RpcResult } from './runtime-contracts.js'

const TOKEN = /^[A-Za-z0-9_-]{43}$/
const MAX_BACKOFF_MS = 5 * 60 * 1000
const GAP_THRESHOLD_MS = 3 * 60 * 1000
const SIGNIFICANT_DISPLACEMENT_M = 250
const MOVE_SPEED_MPS = 1.4
const STOP_SPEED_MPS = 0.5

export type CookieHistoryProvenance = 'observed' | 'inferred'
export type CookieInferenceConfidence = 'high' | 'medium' | 'low'

export interface CookieHistoryPoint extends CookiePoint {
  observedAt: string
  provenance: 'observed'
  sourceQuality: CookieSourceQuality
}

export interface CookieHistorySegment {
  id: string
  provenance: CookieHistoryProvenance
  confidence: CookieInferenceConfidence
  method: 'provider-observed' | 'learned-corridor-prior' | 'generic-plausible-fallback'
  startedAt: string
  endedAt: string
  points: Array<{ lat: number; lng: number }>
}

export type CookieKeyframeType =
  | 'session_observation_start'
  | 'movement_start'
  | 'movement_stop'
  | 'dwell_start'
  | 'dwell_end'
  | 'significant_displacement'
  | 'major_direction_change'
  | 'mode_change'
  | 'data_gap_start'
  | 'data_gap_recovered'

export interface CookieKeyframe {
  id: string
  type: CookieKeyframeType
  at: string
  lat: number
  lng: number
  provenance: CookieHistoryProvenance
  confidence: CookieInferenceConfidence
}

export interface CookieHistoryResponse {
  state: CookieSessionPublicStatus['state']
  windowStart: string
  windowEnd: string
  points: CookieHistoryPoint[]
  segments: CookieHistorySegment[]
  keyframes: CookieKeyframe[]
  rawRetentionHours: 24
  derivedModelRetentionDays: 30
  inferenceTruthLabelRequired: true
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  if (new TextEncoder().encode(secret).byteLength < 32) throw new Error('COOKIE_ENCRYPTION_KEY_INVALID')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptCookiePayload(secret: string, sessionId: string, plaintext: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(sessionId) },
    await encryptionKey(secret),
    new TextEncoder().encode(plaintext),
  )
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) }
}

export async function decryptCookiePayload(secret: string, sessionId: string, ciphertext: string, iv: string): Promise<string> {
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv), additionalData: new TextEncoder().encode(sessionId) },
    await encryptionKey(secret),
    base64ToBytes(ciphertext),
  )
  return new TextDecoder().decode(decrypted)
}

function effectiveExpiry(record: CookieSessionRecord): number {
  const hard = Date.parse(record.hardExpiresAt)
  const auth = record.authExpiresAt ? Date.parse(record.authExpiresAt) : Number.POSITIVE_INFINITY
  return Math.min(hard, auth)
}

function metadata(record: CookieSessionRecord, latest: CookieStoredPoint | null): CookieSessionPublicStatus {
  return {
    state: record.state,
    policyVersion: COOKIE_POLICY_VERSION,
    format: record.format,
    cookieCount: record.retainedCount,
    totalParsed: record.totalParsed,
    expiredDropped: record.expiredDropped,
    invalidDropped: record.invalidDropped,
    retainedCount: record.retainedCount,
    expiresAt: new Date(effectiveExpiry(record)).toISOString(),
    validatedAt: record.validatedAt,
    locationAvailable: record.state === 'ready' && latest !== null,
  }
}

function cellId(point: { lat: number; lng: number }): string {
  return `${Math.round(point.lat * 1000) / 1000},${Math.round(point.lng * 1000) / 1000}`
}

function timeBucket(iso: string): number {
  const date = new Date(iso)
  const santaFeHour = (date.getUTCHours() + 21) % 24
  return Math.max(0, Math.min(5, Math.floor(santaFeHour / 4)))
}

function haversineMeters(left: { lat: number; lng: number }, right: { lat: number; lng: number }): number {
  const radians = (degrees: number) => degrees * Math.PI / 180
  const earth = 6_371_000
  const lat1 = radians(left.lat)
  const lat2 = radians(right.lat)
  const dLat = lat2 - lat1
  const dLng = radians(right.lng - left.lng)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return earth * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)))
}

function bearingDegrees(left: { lat: number; lng: number }, right: { lat: number; lng: number }): number {
  const radians = (degrees: number) => degrees * Math.PI / 180
  const degrees = (value: number) => value * 180 / Math.PI
  const lat1 = radians(left.lat)
  const lat2 = radians(right.lat)
  const dLng = radians(right.lng - left.lng)
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (degrees(Math.atan2(y, x)) + 360) % 360
}

function angleDelta(left: number, right: number): number {
  const delta = Math.abs(left - right) % 360
  return Math.min(delta, 360 - delta)
}

function normalizedSample(sample: CookiePoint, observedAt: string): Omit<CookieStoredPoint, 'id'> | null {
  if (!Number.isFinite(sample.lat) || !Number.isFinite(sample.lng) || sample.lat < -90 || sample.lat > 90 || sample.lng < -180 || sample.lng > 180) return null
  const capturedMs = Date.parse(sample.capturedAt)
  if (!Number.isFinite(capturedMs)) return null
  return {
    capturedAt: new Date(capturedMs).toISOString(),
    observedAt: sample.observedAt && Number.isFinite(Date.parse(sample.observedAt)) ? new Date(sample.observedAt).toISOString() : observedAt,
    lat: sample.lat,
    lng: sample.lng,
    accuracyM: sample.accuracyM !== null && Number.isFinite(sample.accuracyM) && sample.accuracyM >= 0 ? sample.accuracyM : null,
    provenance: 'provider_observed',
    sourceQuality: sample.sourceQuality === 'provider_timestamp' ? 'provider_timestamp' : 'stracker_observed_at',
  }
}

function inferredPoints(left: CookieStoredPoint, right: CookieStoredPoint): Array<{ lat: number; lng: number }> {
  const points: Array<{ lat: number; lng: number }> = []
  const steps = 6
  for (let index = 0; index <= steps; index += 1) {
    const ratio = index / steps
    points.push({
      lat: left.lat + (right.lat - left.lat) * ratio,
      lng: left.lng + (right.lng - left.lng) * ratio,
    })
  }
  return points
}

function historySegments(store: SqliteCookieSessionStore, points: CookieStoredPoint[]): CookieHistorySegment[] {
  if (!points.length) return []
  const result: CookieHistorySegment[] = []
  let observed: CookieStoredPoint[] = [points[0]]
  let observedIndex = 0
  const flushObserved = () => {
    if (!observed.length) return
    result.push({
      id: `observed-${observedIndex++}`,
      provenance: 'observed',
      confidence: 'high',
      method: 'provider-observed',
      startedAt: observed[0].capturedAt,
      endedAt: observed[observed.length - 1].capturedAt,
      points: observed.map((point) => ({ lat: point.lat, lng: point.lng })),
    })
    observed = []
  }
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    const gapMs = Date.parse(current.capturedAt) - Date.parse(previous.capturedAt)
    if (gapMs <= GAP_THRESHOLD_MS) {
      observed.push(current)
      continue
    }
    flushObserved()
    const prior = store.transitionPrior(cellId(previous), cellId(current), timeBucket(previous.capturedAt))
    const confidence: CookieInferenceConfidence = prior.count >= 3 ? 'high' : prior.count >= 1 ? 'medium' : 'low'
    result.push({
      id: `inferred-gap-${index}`,
      provenance: 'inferred',
      confidence,
      method: prior.count >= 1 ? 'learned-corridor-prior' : 'generic-plausible-fallback',
      startedAt: previous.capturedAt,
      endedAt: current.capturedAt,
      points: inferredPoints(previous, current),
    })
    observed = [current]
  }
  flushObserved()
  return result
}

function keyframes(points: CookieStoredPoint[], segments: CookieHistorySegment[]): CookieKeyframe[] {
  if (!points.length) return []
  const frames: CookieKeyframe[] = [{
    id: 'session-observation-start',
    type: 'session_observation_start',
    at: points[0].capturedAt,
    lat: points[0].lat,
    lng: points[0].lng,
    provenance: 'observed',
    confidence: 'high',
  }]
  let moving = false
  let previousBearing: number | null = null
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    const durationMs = Math.max(1, Date.parse(current.capturedAt) - Date.parse(previous.capturedAt))
    const distanceM = haversineMeters(previous, current)
    const speedMps = distanceM / (durationMs / 1000)
    const nowMoving = speedMps >= MOVE_SPEED_MPS
    if (!moving && nowMoving) frames.push({ id: `move-${index}`, type: 'movement_start', at: current.capturedAt, lat: current.lat, lng: current.lng, provenance: 'observed', confidence: 'high' })
    if (moving && speedMps <= STOP_SPEED_MPS) frames.push({ id: `stop-${index}`, type: 'movement_stop', at: current.capturedAt, lat: current.lat, lng: current.lng, provenance: 'observed', confidence: 'high' })
    if (distanceM >= SIGNIFICANT_DISPLACEMENT_M) frames.push({ id: `displacement-${index}`, type: 'significant_displacement', at: current.capturedAt, lat: current.lat, lng: current.lng, provenance: 'observed', confidence: 'high' })
    const bearing = bearingDegrees(previous, current)
    if (previousBearing !== null && distanceM >= 50 && angleDelta(previousBearing, bearing) >= 60) frames.push({ id: `direction-${index}`, type: 'major_direction_change', at: current.capturedAt, lat: current.lat, lng: current.lng, provenance: 'observed', confidence: 'medium' })
    if (durationMs > GAP_THRESHOLD_MS) {
      frames.push({ id: `gap-start-${index}`, type: 'data_gap_start', at: previous.capturedAt, lat: previous.lat, lng: previous.lng, provenance: 'observed', confidence: 'high' })
      frames.push({ id: `gap-recovered-${index}`, type: 'data_gap_recovered', at: current.capturedAt, lat: current.lat, lng: current.lng, provenance: 'observed', confidence: 'high' })
    }
    moving = nowMoving
    previousBearing = bearing
  }
  for (const segment of segments) {
    if (segment.provenance !== 'inferred' || !segment.points.length) continue
    const middle = segment.points[Math.floor(segment.points.length / 2)]
    frames.push({ id: `inference-${segment.id}`, type: 'mode_change', at: segment.startedAt, lat: middle.lat, lng: middle.lng, provenance: 'inferred', confidence: segment.confidence })
  }
  return frames.sort((left, right) => Date.parse(left.at) - Date.parse(right.at)).slice(-80)
}

export class DurableCookieSessionRuntime {
  constructor(
    private readonly store: SqliteCookieSessionStore,
    private readonly encryptionSecret: string,
    private readonly probe: CookieProbe = probeGoogleCookieSession,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async authorized(sessionId: string, ownerToken: string): Promise<RpcResult<CookieSessionRecord>> {
    if (!TOKEN.test(sessionId) || !TOKEN.test(ownerToken)) return { ok: false, status: 404, code: 'NOT_FOUND' }
    const record = this.store.session(sessionId)
    if (!record) return { ok: false, status: 404, code: 'NOT_FOUND' }
    const nowMs = this.now().getTime()
    if (Date.parse(record.hardExpiresAt) <= nowMs) {
      this.store.deleteSessionData(sessionId)
      return { ok: false, status: 410, code: 'COOKIE_SESSION_EXPIRED' }
    }
    const verifier = await capabilityVerifier(ownerToken)
    if (verifier !== record.ownerVerifier) return { ok: false, status: 404, code: 'NOT_FOUND' }
    if (record.state !== 'auth_expired' && record.authExpiresAt && Date.parse(record.authExpiresAt) <= nowMs) {
      this.store.markAuthExpired(sessionId, this.now().toISOString())
      return { ok: true, value: this.store.session(sessionId) as CookieSessionRecord }
    }
    return { ok: true, value: record }
  }

  private async cookies(record: CookieSessionRecord): Promise<NormalizedCookie[]> {
    if (!record.ciphertext || !record.iv) throw new Error('COOKIE_CIPHERTEXT_UNAVAILABLE')
    const raw = await decryptCookiePayload(this.encryptionSecret, record.sessionId, record.ciphertext, record.iv)
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) throw new Error('COOKIE_CIPHERTEXT_INVALID')
    return parsed as NormalizedCookie[]
  }

  private recordSamples(samples: readonly CookiePoint[], observedAt: string): void {
    const cutoff = new Date(this.now().getTime() - COOKIE_HISTORY_WINDOW_MS).toISOString()
    this.store.pruneRawHistory(cutoff)
    this.store.pruneMobility(new Date(this.now().getTime() - COOKIE_MOBILITY_RETENTION_MS).toISOString())
    let previous = this.store.latestPoint()
    const normalized = samples
      .map((sample) => normalizedSample(sample, observedAt))
      .filter((sample): sample is Omit<CookieStoredPoint, 'id'> => sample !== null)
      .filter((sample) => Date.parse(sample.capturedAt) >= Date.parse(cutoff))
      .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt))
    for (const sample of normalized) {
      if (previous && Date.parse(sample.capturedAt) < Date.parse(previous.capturedAt) && sample.sourceQuality !== 'provider_timestamp') continue
      if (!this.store.insertObservedPoint(sample)) continue
      const current: CookieStoredPoint = { id: -1, ...sample }
      const durationMs = previous ? Math.max(0, Date.parse(current.capturedAt) - Date.parse(previous.capturedAt)) : 0
      this.store.recordMobilityCell(cellId(current), timeBucket(current.capturedAt), previous && cellId(previous) === cellId(current) ? durationMs : 0, current.observedAt)
      if (previous && durationMs > 0 && cellId(previous) !== cellId(current)) {
        this.store.recordMobilityTransition(cellId(previous), cellId(current), timeBucket(previous.capturedAt), durationMs, current.observedAt)
      }
      if (!previous || Date.parse(current.capturedAt) >= Date.parse(previous.capturedAt)) previous = current
    }
  }

  private async sample(record: CookieSessionRecord, force: boolean): Promise<RpcResult<CookieSessionPublicStatus>> {
    const now = this.now()
    const nowMs = now.getTime()
    if (record.state === 'auth_expired') return { ok: false, status: 401, code: 'COOKIE_AUTH_EXPIRED' }
    if (!force && record.nextSampleAt && Date.parse(record.nextSampleAt) > nowMs) return { ok: true, value: metadata(record, this.store.latestPoint()) }
    if (force && nowMs - Date.parse(record.lastProbeAt) < COOKIE_REFRESH_MIN_INTERVAL_MS) return { ok: false, status: 429, code: 'FREQUENCY_LIMIT' }
    let probeResult
    try {
      probeResult = await this.probe(await this.cookies(record))
    } catch {
      return { ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }
    }
    const observedAt = now.toISOString()
    if (!probeResult.ok) {
      if (probeResult.code === 'COOKIE_AUTH_EXPIRED') {
        this.store.markAuthExpired(record.sessionId, observedAt)
        return probeResult
      }
      const failures = Math.min(8, record.consecutiveFailures + 1)
      const backoff = Math.min(MAX_BACKOFF_MS, COOKIE_SAMPLE_INTERVAL_MS * (2 ** Math.max(0, failures - 1)))
      this.store.updateTransientFailure(record.sessionId, observedAt, new Date(nowMs + backoff).toISOString(), failures)
      return probeResult
    }
    const samples = probeResult.points ?? (probeResult.point ? [probeResult.point] : [])
    this.recordSamples(samples, observedAt)
    this.store.updateProbeState(record.sessionId, probeResult.state, observedAt, observedAt, new Date(nowMs + COOKIE_SAMPLE_INTERVAL_MS).toISOString())
    const updated = this.store.session(record.sessionId)
    if (!updated) return { ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }
    return { ok: true, value: metadata(updated, this.store.latestPoint()) }
  }

  async importSession(input: CookieSessionImportInput): Promise<RpcResult<CookieSessionPublicStatus>> {
    try {
      if (!TOKEN.test(input.sessionId) || !TOKEN.test(input.ownerVerifier)) return { ok: false, status: 400, code: 'REQUEST_INVALID' }
      const parsed = parseCookieSession(input.raw)
      const probe = await this.probe(parsed.cookies)
      if (!probe.ok) return probe
      const now = this.now()
      const duration = Math.max(MIN_COOKIE_SESSION_DURATION_MS, Math.min(MAX_COOKIE_SESSION_DURATION_MS, Math.floor(input.durationMs)))
      const hardExpiresAtMs = now.getTime() + duration
      if (parsed.authExpiresAt !== null && parsed.authExpiresAt <= now.getTime()) return { ok: false, status: 401, code: 'COOKIE_AUTH_EXPIRED' }
      const encrypted = await encryptCookiePayload(this.encryptionSecret, input.sessionId, JSON.stringify(parsed.cookies))
      const record: CookieSessionRecord = {
        sessionId: input.sessionId,
        ownerVerifier: input.ownerVerifier,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        format: parsed.format,
        totalParsed: parsed.totalParsed,
        expiredDropped: parsed.expiredDropped,
        invalidDropped: parsed.invalidDropped,
        retainedCount: parsed.retainedCount,
        createdAt: now.toISOString(),
        hardExpiresAt: new Date(hardExpiresAtMs).toISOString(),
        authExpiresAt: parsed.authExpiresAt === null ? null : new Date(parsed.authExpiresAt).toISOString(),
        validatedAt: now.toISOString(),
        state: probe.state,
        lastProbeAt: now.toISOString(),
        nextSampleAt: new Date(now.getTime() + COOKIE_SAMPLE_INTERVAL_MS).toISOString(),
        consecutiveFailures: 0,
      }
      this.store.putSession(record)
      this.recordSamples(probe.points ?? (probe.point ? [probe.point] : []), now.toISOString())
      return { ok: true, value: metadata(record, this.store.latestPoint()) }
    } catch (error) {
      if (error instanceof CookieContractError) return { ok: false, status: error.status, code: error.code }
      return { ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }
    }
  }

  async status(sessionId: string, ownerToken: string): Promise<RpcResult<CookieSessionPublicStatus>> {
    const authorized = await this.authorized(sessionId, ownerToken)
    return authorized.ok ? { ok: true, value: metadata(authorized.value, this.store.latestPoint()) } : authorized
  }

  async point(sessionId: string, ownerToken: string): Promise<RpcResult<CookieSessionPointResponse>> {
    const authorized = await this.authorized(sessionId, ownerToken)
    if (!authorized.ok) return authorized
    const latest = this.store.latestPoint()
    return {
      ok: true,
      value: {
        state: authorized.value.state,
        point: latest ? {
          lat: latest.lat,
          lng: latest.lng,
          accuracyM: latest.accuracyM,
          capturedAt: latest.capturedAt,
          observedAt: latest.observedAt,
          sourceQuality: latest.sourceQuality,
        } : null,
        validatedAt: authorized.value.validatedAt,
      },
    }
  }

  async refresh(sessionId: string, ownerToken: string): Promise<RpcResult<CookieSessionPublicStatus>> {
    const authorized = await this.authorized(sessionId, ownerToken)
    if (!authorized.ok) return authorized
    return this.sample(authorized.value, true)
  }

  async history(sessionId: string, ownerToken: string, sinceIso: string): Promise<RpcResult<CookieHistoryResponse>> {
    const authorized = await this.authorized(sessionId, ownerToken)
    if (!authorized.ok) return authorized
    const now = this.now()
    const minimum = now.getTime() - COOKIE_HISTORY_WINDOW_MS
    const requested = Date.parse(sinceIso)
    const since = Number.isFinite(requested) ? Math.max(minimum, Math.min(now.getTime(), requested)) : minimum
    const points = this.store.pointsSince(new Date(since).toISOString())
    const segments = historySegments(this.store, points)
    return {
      ok: true,
      value: {
        state: authorized.value.state,
        windowStart: new Date(since).toISOString(),
        windowEnd: now.toISOString(),
        points: points.map((point) => ({
          lat: point.lat,
          lng: point.lng,
          accuracyM: point.accuracyM,
          capturedAt: point.capturedAt,
          observedAt: point.observedAt,
          provenance: 'observed',
          sourceQuality: point.sourceQuality,
        })),
        segments,
        keyframes: keyframes(points, segments),
        rawRetentionHours: 24,
        derivedModelRetentionDays: 30,
        inferenceTruthLabelRequired: true,
      },
    }
  }

  async clearMobility(sessionId: string, ownerToken: string): Promise<RpcResult<null>> {
    const authorized = await this.authorized(sessionId, ownerToken)
    if (!authorized.ok) return authorized
    this.store.clearMobility()
    return { ok: true, value: null }
  }

  async delete(sessionId: string, ownerToken: string): Promise<RpcResult<null>> {
    const authorized = await this.authorized(sessionId, ownerToken)
    if (!authorized.ok) return authorized
    this.store.deleteSessionData(sessionId)
    return { ok: true, value: null }
  }

  nextAlarmAtMs(): number | null {
    return this.store.nextAlarmAtMs()
  }

  async onAlarm(): Promise<void> {
    const record = this.store.session()
    if (!record) return
    const nowMs = this.now().getTime()
    if (Date.parse(record.hardExpiresAt) <= nowMs) {
      this.store.deleteSessionData(record.sessionId)
      return
    }
    if (record.authExpiresAt && Date.parse(record.authExpiresAt) <= nowMs) {
      this.store.markAuthExpired(record.sessionId, this.now().toISOString())
      return
    }
    if (record.state === 'auth_expired') return
    if (!record.nextSampleAt || Date.parse(record.nextSampleAt) <= nowMs) await this.sample(record, false)
  }
}
