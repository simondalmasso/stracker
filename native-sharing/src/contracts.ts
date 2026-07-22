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

export interface NativeSharedLocationPoint {
  version: 1
  sequence: number
  lat: number
  lng: number
  accuracyM: number | null
  speedMps: number | null
  headingDeg: number | null
  capturedAt: string
}

export interface AcceptedNativePoint extends NativeSharedLocationPoint {
  receivedAt: string
  sessionId: string
  acceptanceState: 'accepted'
}

export interface NativeSharingSession {
  id: string
  emitterVerifier: string
  viewerVerifier: string
  viewerGeneration: number
  state: 'active' | 'revoked' | 'expired'
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  lastSequence: number
  lastCapturedAt: string | null
  lastReceivedAt: string | null
  pointCount: number
}

export interface OpaqueViewerSession {
  tokenVerifier: string
  sharingSessionId: string
  viewerGeneration: number
  createdAt: string
  expiresAt: string
  revokedAt: string | null
}

export interface NativeSharingSegment {
  id: string
  points: AcceptedNativePoint[]
  startedAt: string
  endedAt: string
}

export interface CreateSessionInput {
  session: NativeSharingSession
}

export interface AppendPointResult {
  session: NativeSharingSession
  point: AcceptedNativePoint
}

export interface NativeSharingStore {
  createSession(input: CreateSessionInput): Promise<NativeSharingSession>
  getSession(sessionId: string): Promise<NativeSharingSession | null>
  appendPoint(sessionId: string, expectedLastSequence: number, point: AcceptedNativePoint): Promise<AppendPointResult>
  getLatestPoint(sessionId: string): Promise<AcceptedNativePoint | null>
  getConfirmedSegments(sessionId: string, maxSegments?: number): Promise<NativeSharingSegment[]>
  createViewerSession(sessionId: string, viewerSession: OpaqueViewerSession): Promise<OpaqueViewerSession>
  getViewerSession(sessionId: string, tokenVerifier: string): Promise<OpaqueViewerSession | null>
  revokeViewerSession(sessionId: string, tokenVerifier: string, revokedAt: string): Promise<boolean>
  revokeAllViewerSessions(sessionId: string, revokedAt: string): Promise<number>
  revokeSession(sessionId: string, revokedAt: string): Promise<NativeSharingSession | null>
  rotateViewerCapability(sessionId: string, verifier: string, revokedAt: string): Promise<NativeSharingSession | null>
  deleteExpired(nowIso: string): Promise<number>
}

export interface CreateSessionResponse {
  sessionId: string
  emitterToken: string
  viewerCapability: string
  expiresAt: string
}

export interface ViewerExchangeResponse {
  sessionId: string
  viewerSessionToken: string
  viewerGeneration: number
  expiresAt: string
}

export interface ViewerStatusResponse {
  state: ViewerSessionState
  expiresAt: string
  lastUpdate: string | null
  pointCount: number
}

export interface ViewerPointsResponse {
  state: ViewerSessionState
  points: AcceptedNativePoint[]
  segments: NativeSharingSegment[]
  lastUpdate: string | null
}
