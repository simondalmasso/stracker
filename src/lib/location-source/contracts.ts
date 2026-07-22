export type LocationSource = 'my-device' | 'shared-location'
export type SharedLocationProvider = 'stracker-native' | 'google-session-experimental'
export type MotionState = 'unknown' | 'stationary' | 'moving'
export type FreshnessState = 'unknown' | 'fresh' | 'stale' | 'expired'
export type SourceHealth = 'unknown' | 'receiving' | 'degraded' | 'unreachable'
export type SharingSessionState =
  | 'not-started'
  | 'requesting-permission'
  | 'active'
  | 'paused'
  | 'expired'
  | 'revoked'
  | 'permission-denied'
  | 'error'
export type ViewerSessionState =
  | 'unconfirmed'
  | 'validating'
  | 'active'
  | 'stale'
  | 'expired'
  | 'revoked'
  | 'invalid'
export type LocationSessionState = 'not-applicable' | ViewerSessionState
export type CameraMode = 'overview' | 'follow' | 'stationary' | 'manual'
export type BasemapMode = 'vector-3d' | 'satellite' | 'hybrid'

export interface GeoPoint {
  lat: number
  lng: number
}

export interface NativeSharedLocationPoint extends GeoPoint {
  version: 1
  sequence: number
  accuracyM: number | null
  speedMps: number | null
  headingDeg: number | null
  capturedAt: string
}

export interface AcceptedNativeSharedLocationPoint extends NativeSharedLocationPoint {
  receivedAt: string
  sessionId: string
  acceptanceState: 'accepted'
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
  viewerSession: LocationSessionState
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

export interface NativeViewerStatus {
  state: ViewerSessionState
  expiresAt: string
  lastUpdate: string | null
  pointCount: number
}

export interface NativeViewerPoints {
  state: ViewerSessionState
  points: AcceptedNativeSharedLocationPoint[]
  lastUpdate: string | null
}

export interface NativeCreateSessionResponse {
  sessionId: string
  emitterToken: string
  viewerCapability: string
  expiresAt: string
}

export function freshnessFromTimestamp(
  source: LocationSource,
  capturedAt: string,
  nowMs = Date.now(),
): FreshnessState {
  const capturedMs = Date.parse(capturedAt)
  if (!Number.isFinite(capturedMs)) return 'unknown'
  const ageMs = Math.max(0, nowMs - capturedMs)
  const freshMs = source === 'my-device' ? 30_000 : 60_000
  const staleMs = source === 'my-device' ? 120_000 : 300_000
  if (ageMs <= freshMs) return 'fresh'
  if (ageMs <= staleMs) return 'stale'
  return 'expired'
}

export function isMapUnlocked(
  source: LocationSource,
  myState: MyLocationState,
  viewerState: ViewerSessionState,
): boolean {
  if (source === 'my-device') return myState === 'MY_LOCATION_READY'
  return viewerState === 'active' || viewerState === 'stale'
}
