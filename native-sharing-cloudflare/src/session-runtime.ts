import type {
  AcceptedNativePoint,
  CreateSessionInput,
  NativeSharedLocationPoint,
  NativeSharingSession,
  ViewerExchangeResponse,
  ViewerPointsResponse,
  ViewerStatusResponse,
} from '../../native-sharing/src/contracts.js'
import { PointValidationError } from '../../native-sharing/src/geo.js'
import { NativeSharingError, NativeSharingService } from '../../native-sharing/src/service.js'
import type { RpcResult, RuntimeErrorCode } from './runtime-contracts.js'
import { NativeSharingStoreFault, SqliteNativeSharingStore } from './sqlite-store.js'

const POINT_VALIDATION_STATUS: Readonly<Record<string, number>> = {
  RETENTION_LIMIT: 429,
  FREQUENCY_LIMIT: 429,
  REPLAY_REJECTED: 409,
  TIMESTAMP_REPLAY: 409,
  VERSION_REJECTED: 422,
  SEQUENCE_INVALID: 422,
  LATITUDE_INVALID: 422,
  LONGITUDE_INVALID: 422,
  ACCURACY_INVALID: 422,
  SPEED_INVALID: 422,
  HEADING_INVALID: 422,
  TIMESTAMP_INVALID: 422,
  TIMESTAMP_FUTURE: 422,
  TIMESTAMP_TOO_OLD: 422,
  IMPOSSIBLE_JUMP: 422,
}

function classifyUnknown(error: unknown): { status: number; code: RuntimeErrorCode } {
  if (error instanceof NativeSharingError) {
    return { status: error.status, code: error.code as RuntimeErrorCode }
  }
  if (error instanceof PointValidationError) {
    if (error.code === 'RETENTION_LIMIT') return { status: 429, code: 'POINT_QUOTA_EXCEEDED' }
    return { status: POINT_VALIDATION_STATUS[error.code] ?? 422, code: error.code as RuntimeErrorCode }
  }
  if (error instanceof NativeSharingStoreFault) {
    switch (error.code) {
      case 'SESSION_COLLISION': return { status: 409, code: 'SESSION_COLLISION' }
      case 'SEQUENCE_RACE': return { status: 409, code: 'SEQUENCE_RACE' }
      case 'SESSION_INACTIVE': return { status: 410, code: 'SESSION_INACTIVE' }
      case 'POINT_QUOTA_EXCEEDED': return { status: 429, code: 'POINT_QUOTA_EXCEEDED' }
      case 'VIEWER_SESSION_QUOTA_EXCEEDED': return { status: 429, code: 'VIEWER_SESSION_QUOTA_EXCEEDED' }
      case 'VIEWER_GENERATION_RACE': return { status: 409, code: 'VIEWER_SESSION_INVALID' }
      default: return { status: 503, code: 'STORAGE_UNAVAILABLE' }
    }
  }
  if (error instanceof Error && /SQLITE_FULL|database or disk is full/i.test(error.message)) {
    return { status: 507, code: 'STORAGE_QUOTA_EXCEEDED' }
  }
  return { status: 503, code: 'STORAGE_UNAVAILABLE' }
}

export class NativeSharingSessionRuntime {
  private readonly service: NativeSharingService

  constructor(readonly store: SqliteNativeSharingStore, now: () => Date = () => new Date()) {
    this.service = new NativeSharingService(store, now)
  }

  private async guard<T>(operation: () => Promise<T>): Promise<RpcResult<T>> {
    try {
      return { ok: true, value: await operation() }
    } catch (error) {
      const classified = classifyUnknown(error)
      return { ok: false, status: classified.status, code: classified.code }
    }
  }

  createSession(input: CreateSessionInput): Promise<RpcResult<NativeSharingSession>> {
    return this.guard(() => this.store.createSession(input))
  }

  appendPoint(sessionId: string, emitterToken: string, point: NativeSharedLocationPoint): Promise<RpcResult<AcceptedNativePoint>> {
    return this.guard(() => this.service.appendPoint(sessionId, emitterToken, point))
  }

  exchangeViewerCapability(viewerCapability: string): Promise<RpcResult<ViewerExchangeResponse>> {
    return this.guard(() => this.service.exchangeViewerCapability(viewerCapability))
  }

  getStatus(sessionId: string, viewerSessionToken: string): Promise<RpcResult<ViewerStatusResponse>> {
    return this.guard(() => this.service.getStatus(sessionId, viewerSessionToken))
  }

  getPoints(sessionId: string, viewerSessionToken: string): Promise<RpcResult<ViewerPointsResponse>> {
    return this.guard(() => this.service.getPoints(sessionId, viewerSessionToken))
  }

  async logoutViewer(sessionId: string, viewerSessionToken: string): Promise<RpcResult<null>> {
    return this.guard(async () => {
      await this.service.logoutViewer(sessionId, viewerSessionToken)
      return null
    })
  }

  rotateViewer(sessionId: string, emitterToken: string): Promise<RpcResult<{ viewerCapability: string; viewerGeneration: number }>> {
    return this.guard(() => this.service.rotateViewer(sessionId, emitterToken))
  }

  async revoke(sessionId: string, emitterToken: string): Promise<RpcResult<null>> {
    return this.guard(async () => {
      await this.service.revoke(sessionId, emitterToken)
      return null
    })
  }
}
