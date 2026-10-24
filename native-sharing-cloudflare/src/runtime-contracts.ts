import type {
  AcceptedNativePoint,
  CreateSessionInput,
  CreateSessionResponse,
  NativeSharedLocationPoint,
  NativeSharingSession,
  ViewerExchangeResponse,
  ViewerPointsResponse,
  ViewerStatusResponse,
} from '../../native-sharing/src/contracts.js'
import type { CookieHistoryResponse } from './cookie-session-durable.js'
import type { CookieSessionImportInput, CookieSessionPointResponse, CookieSessionPublicStatus } from './cookie-session.js'

export type RuntimeErrorCode =
  | 'NOT_FOUND'
  | 'REQUEST_INVALID'
  | 'METHOD_NOT_ALLOWED'
  | 'ORIGIN_REJECTED'
  | 'BODY_TOO_LARGE'
  | 'CONTENT_TYPE_REQUIRED'
  | 'SESSION_COLLISION'
  | 'SESSION_REVOKED'
  | 'SESSION_EXPIRED'
  | 'SESSION_INACTIVE'
  | 'VIEWER_SESSION_INVALID'
  | 'VIEWER_SESSION_EXPIRED'
  | 'POINT_QUOTA_EXCEEDED'
  | 'VIEWER_SESSION_QUOTA_EXCEEDED'
  | 'SEQUENCE_RACE'
  | 'VERSION_REJECTED'
  | 'SEQUENCE_INVALID'
  | 'REPLAY_REJECTED'
  | 'LATITUDE_INVALID'
  | 'LONGITUDE_INVALID'
  | 'ACCURACY_INVALID'
  | 'SPEED_INVALID'
  | 'HEADING_INVALID'
  | 'TIMESTAMP_INVALID'
  | 'TIMESTAMP_FUTURE'
  | 'TIMESTAMP_TOO_OLD'
  | 'TIMESTAMP_REPLAY'
  | 'FREQUENCY_LIMIT'
  | 'IMPOSSIBLE_JUMP'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'STORAGE_UNAVAILABLE'
  | 'BINDING_UNAVAILABLE'
  | 'OPERATION_TIMEOUT'
  | 'CAPABILITY_GENERATION_FAILED'
  | 'COOKIE_FORMAT_UNRECOGNIZED'
  | 'COOKIE_INVALID'
  | 'COOKIE_DOMAIN_REJECTED'
  | 'COOKIE_SET_INCOMPLETE'
  | 'COOKIE_EXPIRED'
  | 'COOKIE_AUTH_EXPIRED'
  | 'COOKIE_PROVIDER_UNAVAILABLE'
  | 'COOKIE_SESSION_EXPIRED'

export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: RuntimeErrorCode }

export interface NativeSharingRpcStub {
  createSession(input: CreateSessionInput): Promise<RpcResult<NativeSharingSession>>
  appendPoint(sessionId: string, emitterToken: string, point: NativeSharedLocationPoint): Promise<RpcResult<AcceptedNativePoint>>
  exchangeViewerCapability(viewerCapability: string): Promise<RpcResult<ViewerExchangeResponse>>
  getStatus(sessionId: string, viewerSessionToken: string): Promise<RpcResult<ViewerStatusResponse>>
  getPoints(sessionId: string, viewerSessionToken: string): Promise<RpcResult<ViewerPointsResponse>>
  logoutViewer(sessionId: string, viewerSessionToken: string): Promise<RpcResult<null>>
  rotateViewer(sessionId: string, emitterToken: string): Promise<RpcResult<{ viewerCapability: string; viewerGeneration: number }>>
  revoke(sessionId: string, emitterToken: string): Promise<RpcResult<null>>
  importCookieSession(input: CookieSessionImportInput): Promise<RpcResult<CookieSessionPublicStatus>>
  getCookieSessionStatus(sessionId: string, ownerToken: string): Promise<RpcResult<CookieSessionPublicStatus>>
  getCookieSessionPoint(sessionId: string, ownerToken: string): Promise<RpcResult<CookieSessionPointResponse>>
  getCookieSessionHistory(sessionId: string, ownerToken: string, sinceIso: string): Promise<RpcResult<CookieHistoryResponse>>
  refreshCookieSession(sessionId: string, ownerToken: string): Promise<RpcResult<CookieSessionPublicStatus>>
  clearCookieMobility(sessionId: string, ownerToken: string): Promise<RpcResult<null>>
  deleteCookieSession(sessionId: string, ownerToken: string): Promise<RpcResult<null>>
}

export interface NativeSharingNamespaceBinding {
  getByName(name: string): NativeSharingRpcStub
}

export interface StaticAssetsBinding {
  fetch(request: Request): Promise<Response>
}

export interface NativeSharingRuntimeBindings {
  NATIVE_SHARING?: NativeSharingNamespaceBinding
  ASSETS?: StaticAssetsBinding
}

export interface RuntimeCreateSessionRequest {
  durationMs?: number
}

export interface RuntimeViewerExchangeRequest {
  viewerCapability: string
}

export interface RuntimeViewerLogoutRequest {
  sessionId: string
}

export interface RuntimeCookieSessionRequest {
  raw: string
  durationMs?: number
  mobilityScope?: string
}

export type { CreateSessionResponse }
