export type LocationSource = 'my-device' | 'google-shared'

export type Freshness = 'fresh' | 'stale' | 'dead'

export interface LocationSnapshot {
  source: LocationSource
  lat: number
  lng: number
  accuracyM: number | null
  capturedAt: string
  receivedAt: string
  freshness: Freshness
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
  capturedAt: string,
  nowMs = Date.now(),
): Freshness {
  const capturedMs = Date.parse(capturedAt)
  if (!Number.isFinite(capturedMs)) return 'dead'
  const ageMs = Math.max(0, nowMs - capturedMs)
  if (ageMs <= 60_000) return 'fresh'
  if (ageMs <= 300_000) return 'stale'
  return 'dead'
}

export function isMapUnlocked(
  source: LocationSource,
  myState: MyLocationState,
  sharedState: SharedLocationState,
): boolean {
  if (source === 'my-device') return myState === 'MY_LOCATION_READY'
  return (
    sharedState === 'SHARED_READY' ||
    sharedState === 'SHARED_STALE' ||
    sharedState === 'SHARED_NO_LOCATION'
  )
}
