import { DurableObject } from 'cloudflare:workers'
import type {
  AcceptedNativePoint,
  CreateSessionInput,
  NativeSharedLocationPoint,
  NativeSharingSession,
  ViewerExchangeResponse,
  ViewerPointsResponse,
  ViewerStatusResponse,
} from '../../native-sharing/src/contracts.js'
import type { RpcResult } from './runtime-contracts.js'
import { DELETE_AFTER_EXPIRATION_MS } from './runtime-limits.js'
import { NativeSharingSessionRuntime } from './session-runtime.js'
import type { RuntimeSqlExecutor, RuntimeSqlRow, RuntimeSqlValue } from './sqlite-store.js'
import { SqliteNativeSharingStore } from './sqlite-store.js'

function sqlExecutor(sql: DurableObjectStorage['sql']): RuntimeSqlExecutor {
  return {
    exec<T extends RuntimeSqlRow = RuntimeSqlRow>(query: string, ...bindings: RuntimeSqlValue[]) {
      return sql.exec<T>(query, ...bindings)
    },
  }
}

export class NativeSharingDurableObject extends DurableObject<Env> {
  private readonly store: SqliteNativeSharingStore
  private readonly runtime: NativeSharingSessionRuntime

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new SqliteNativeSharingStore(sqlExecutor(this.ctx.storage.sql))
    this.runtime = new NativeSharingSessionRuntime(this.store)
    this.ctx.blockConcurrencyWhile(async () => {
      this.store.initializeSchema()
    })
  }

  async createSession(input: CreateSessionInput): Promise<RpcResult<NativeSharingSession>> {
    const result = await this.runtime.createSession(input)
    if (!result.ok) return result
    try {
      await this.ctx.storage.setAlarm(Date.parse(result.value.expiresAt) + DELETE_AFTER_EXPIRATION_MS)
      return result
    } catch {
      await this.runtime.forceRevoke(result.value.id, new Date().toISOString())
      return { ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }
    }
  }

  appendPoint(sessionId: string, emitterToken: string, point: NativeSharedLocationPoint): Promise<RpcResult<AcceptedNativePoint>> {
    return this.runtime.appendPoint(sessionId, emitterToken, point)
  }

  exchangeViewerCapability(viewerCapability: string): Promise<RpcResult<ViewerExchangeResponse>> {
    return this.runtime.exchangeViewerCapability(viewerCapability)
  }

  getStatus(sessionId: string, viewerSessionToken: string): Promise<RpcResult<ViewerStatusResponse>> {
    return this.runtime.getStatus(sessionId, viewerSessionToken)
  }

  getPoints(sessionId: string, viewerSessionToken: string): Promise<RpcResult<ViewerPointsResponse>> {
    return this.runtime.getPoints(sessionId, viewerSessionToken)
  }

  logoutViewer(sessionId: string, viewerSessionToken: string): Promise<RpcResult<null>> {
    return this.runtime.logoutViewer(sessionId, viewerSessionToken)
  }

  rotateViewer(sessionId: string, emitterToken: string): Promise<RpcResult<{ viewerCapability: string; viewerGeneration: number }>> {
    return this.runtime.rotateViewer(sessionId, emitterToken)
  }

  revoke(sessionId: string, emitterToken: string): Promise<RpcResult<null>> {
    return this.runtime.revoke(sessionId, emitterToken)
  }

  async alarm(): Promise<void> {
    const now = new Date()
    const deleted = await this.store.deleteExpired(now.toISOString())
    if (deleted > 0) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    const session = this.ctx.storage.sql.exec<{ expires_at: string }>('SELECT expires_at FROM sharing_session LIMIT 1').toArray()[0]
    if (session) await this.ctx.storage.setAlarm(Date.parse(session.expires_at) + DELETE_AFTER_EXPIRATION_MS)
  }
}
