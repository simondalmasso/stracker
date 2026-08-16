export type LocationSource = 'my-device' | 'shared-location'
export type SharedLocationProvider = 'stracker-native' | 'google-session-experimental'
export type MotionState = 'unknown' | 'stationary' | 'moving'
export type FreshnessState = 'unknown' | 'fresh' | 'delayed' | 'stale' | 'expired'
export type SourceHealth = 'unknown' | 'receiving' | 'degraded' | 'unreachable'
export type SharingSessionState = 'not-started' | 'requesting-permission' | 'active' | 'paused' | 'expired' | 'revoked' | 'permission-denied' | 'error'
export type ViewerSessionState = 'unconfirmed' | 'validating' | 'active' | 'stale' | 'expired' | 'revoked' | 'invalid'
export type LocationSessionState = 'not-applicable' | ViewerSessionState
export type CameraMode = 'overview' | 'follow' | 'stationary' | 'manual'
export type BasemapMode = 'vector-3d' | 'satellite' | 'hybrid'
export type PilotNetworkState = 'online' | 'offline' | 'sending' | 'recovering' | 'error'
export type PilotAccuracyState = 'unknown' | 'good' | 'fair' | 'low'
export type PilotPermissionState = 'granted' | 'prompt' | 'denied' | 'unsupported' | 'unknown'
export type RailProvenance = 'observed' | 'inferred'
export type InferenceConfidence = 'high' | 'medium' | 'low'

export interface GeoPoint { lat: number; lng: number }
export interface NativeSharedLocationPoint extends GeoPoint { version: 1; sequence: number; accuracyM: number | null; speedMps: number | null; headingDeg: number | null; capturedAt: string }
export interface AcceptedNativeSharedLocationPoint extends NativeSharedLocationPoint { receivedAt: string; sessionId: string; acceptanceState: 'accepted' }
export interface LocationSample extends GeoPoint { source: LocationSource; accuracyM: number | null; capturedAt: string; receivedAt: string; speedMps: number | null; headingDeg: number | null }
export interface LocationSnapshot extends LocationSample { freshness: FreshnessState; health: SourceHealth; motion: MotionState; viewerSession: LocationSessionState; visualUpdated: boolean; filterDecision: 'accepted' | 'metadata-only' | 'rejected'; filterReason: string }
export interface GhostRailSegment { id: string; source: LocationSource; sessionEpoch: number; points: GeoPoint[]; startedAt: string; endedAt: string; provenance?: RailProvenance; confidence?: InferenceConfidence; method?: string }
export interface LocationKeyframe extends GeoPoint { id: string; at: string; type: 'session_observation_start' | 'movement_start' | 'movement_stop' | 'dwell_start' | 'dwell_end' | 'significant_displacement' | 'major_direction_change' | 'mode_change' | 'data_gap_start' | 'data_gap_recovered'; provenance: RailProvenance; confidence: InferenceConfidence }
export type ProductFlow = 'SELECTING_SOURCE' | 'MY_LOCATION_FLOW' | 'SHARED_LOCATION_FLOW'
export type MyLocationState = 'MY_LOCATION_IDLE' | 'MY_LOCATION_REQUESTING_PERMISSION' | 'MY_LOCATION_READY' | 'MY_LOCATION_PERMISSION_DENIED' | 'MY_LOCATION_UNAVAILABLE' | 'MY_LOCATION_TIMEOUT' | 'MY_LOCATION_ERROR'
export interface NativeViewerStatus { state: ViewerSessionState; expiresAt: string; lastUpdate: string | null; pointCount: number }
export interface NativeViewerPoints { state: ViewerSessionState; points: AcceptedNativeSharedLocationPoint[]; lastUpdate: string | null }
export interface NativeCreateSessionResponse { sessionId: string; emitterToken: string; viewerCapability: string; expiresAt: string }
export interface NativeViewerExchangeResponse { sessionId: string; viewerSessionToken: string; viewerGeneration: number; expiresAt: string }
export interface PilotRuntimeIdentity { buildSha: string; versionId: string }
export interface PilotDiagnosticSummary { BUILD_SHA: string; VERSION_ID: string; BROWSER_AND_OS_CLASS: string; PAGE_VISIBILITY_STATE: string; GEOLOCATION_PERMISSION_STATE: PilotPermissionState; NETWORK_ONLINE_STATE: string; WAKE_LOCK_SUPPORTED_AND_HELD: string; LAST_HTTP_STATUS_CATEGORY: string; POINT_ATTEMPT_COUNT: number; POINT_SUCCESS_COUNT: number; LAST_SUCCESS_AGE_BUCKET: string }
export function freshnessFromTimestamp(source: LocationSource, capturedAt: string, nowMs = Date.now()): FreshnessState { const capturedMs = Date.parse(capturedAt); if (!Number.isFinite(capturedMs)) return 'unknown'; const ageMs = Math.max(0, nowMs - capturedMs); if (source === 'shared-location') { if (ageMs <= 15_000) return 'fresh'; if (ageMs <= 45_000) return 'delayed'; return 'stale' } if (ageMs <= 30_000) return 'fresh'; if (ageMs <= 120_000) return 'stale'; return 'expired' }
export function isMapUnlocked(source: LocationSource, myState: MyLocationState, viewerState: ViewerSessionState): boolean { if (source === 'my-device') return myState === 'MY_LOCATION_READY'; return viewerState === 'active' || viewerState === 'stale' }
