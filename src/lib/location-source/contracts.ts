export type LocationSource = 'my-device' | 'google-shared'
export type MotionState = 'unknown' | 'stationary' | 'moving'
export type FreshnessState = 'unknown' | 'fresh' | 'stale' | 'expired'
export type SourceHealth = 'unknown' | 'receiving' | 'degraded' | 'unreachable'
export type SharedSessionState =
  | 'not-applicable'
  | 'unconfigured'
  | 'validating'
  | 'valid'
  | 'expired'
  | 'rejected'
  | 'upstream-error'
export type CameraMode = 'overview' | 'follow' | 'stationary' | 'manual'
export type BasemapMode = 'vector-3d' | 'satellite' | 'hybrid'

export interface GeoPoint {
  lat: number
  lng: number
}

export interface LocationSample extends GeoPoint {
  source: LocationSource
  accuracyM: number | null
  capturedAt: string
  receivedAt: string
  speedMps: number | null
  headingDeg: number | null
}

export interface LocationSnapshot extends LocationSample {
  freshness: FreshnessState
  health: SourceHealth
  motion: MotionState
  sharedSession: SharedSessionState
  visualUpdated: boolean
  filterDecision: 'accepted' | 'metadata-only' | 'rejected'
  filterReason: string
}

export interface GhostRailSegment {
  id: string
  source: LocationSource
  sessionEpoch: number
  points: GeoPoint[]
  startedAt: string
  endedAt: string
}

export type ProductFlow =
  | 'SELECTING_SOURCE'
  | 'MY_LOCATION_FLOW'
  | 'SHARED_LOCATION_FLOW'

export type MyLocationState =
  | 'MY_LOCATION_IDLE'
  | 'MY_LOCATION_REQUESTING_PERMISSION'
  | 'MY_LOCATION_READY'
  | 'MY_LOCATION_PERMISSION_DENIED'
  | 'MY_LOCATION_UNAVAILABLE'
  | 'MY_LOCATION_TIMEOUT'
  | 'MY_LOCATION_ERROR'

export type SharedLocationState =
  | 'SHARED_UNCONFIGURED'
  | 'SHARED_IMPORTING'
  | 'SHARED_VALIDATING'
  | 'SHARED_READY'
  | 'SHARED_STALE'
  | 'SHARED_NO_LOCATION'
  | 'SHARED_EXPIRED'
  | 'SHARED_PERMISSION_REVOKED'
  | 'SHARED_ERROR'

export type SharedHealth =
  | 'VALID'
  | 'INVALID'
  | 'EXPIRED'
  | 'INCOMPLETE'
  | 'NO_LOCATION_SHARED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UNSUPPORTED_RESPONSE'
  | 'UNCONFIGURED'

export interface SharedSessionStatus {
  appAuthenticated: boolean
  state: SharedLocationState
  health: SharedHealth
  configured: boolean
  formatDetected: string | null
  count: number
  criticalPresent: string[]
  criticalMissing: string[]
  message: string
}

export interface SharedImportResult extends SharedSessionStatus {
  status: 'ok' | 'error'
  action: string
}

export interface SharedPointsPayload {
  points?: Array<Record<string, unknown>>
  ghostrail_pts?: Array<Record<string, unknown>>
  last_update?: string | null
  state?: Record<string, unknown> | null
}

export function freshnessFromTimestamp(
  source: LocationSource,
  capturedAt: string,
  nowMs = Date.now(),
): FreshnessState {
  const capturedMs = Date.parse(capturedAt)
  if (!Number.isFinite(capturedMs)) return 'unknown'
  const ageMs = Math.max(0, nowMs - capturedMs)
  const freshMs = source === 'my-device' ? 30_000 : 90_000
  const staleMs = source === 'my-device' ? 120_000 : 600_000
  if (ageMs <= freshMs) return 'fresh'
  if (ageMs <= staleMs) return 'stale'
  return 'expired'
}

export function sharedSessionStateFromStatus(
  status: Pick<SharedSessionStatus, 'state' | 'health' | 'configured'> | null,
): SharedSessionState {
  if (!status || !status.configured || status.state === 'SHARED_UNCONFIGURED') return 'unconfigured'
  if (status.state === 'SHARED_VALIDATING' || status.state === 'SHARED_IMPORTING') return 'validating'
  if (status.state === 'SHARED_EXPIRED' || status.health === 'EXPIRED') return 'expired'
  if (status.state === 'SHARED_PERMISSION_REVOKED' || status.health === 'INVALID') return 'rejected'
  if (status.state === 'SHARED_ERROR' || status.health === 'UPSTREAM_UNAVAILABLE') return 'upstream-error'
  return 'valid'
}

export function isMapUnlocked(
  source: LocationSource,
  myState: MyLocationState,
  sharedState: SharedLocationState,
): boolean {
  if (source === 'my-device') return myState === 'MY_LOCATION_READY'
  return sharedState === 'SHARED_READY' || sharedState === 'SHARED_STALE'
}
