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

function sqlExecutor(storage: DurableObjectStorage): RuntimeSqlExecutor {
  return {
    exec<T extends RuntimeSqlRow = RuntimeSqlRow>(query: string, ...bindings: RuntimeSqlValue[]) {
      return storage.sql.exec<T>(query, ...bindings)
    },
    transactionSync<T>(callback: () => T): T {
      return storage.transactionSync(callback)
    },
  }
}

export class NativeSharingDurableObject extends DurableObject<Env> {
  private readonly store: SqliteNativeSharingStore
  private readonly runtime: NativeSharingSessionRuntime
  private schemaDeleted = false
  private testCleanupVerificationOverride: false | null = null
  private testSetAlarmFailure = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new SqliteNativeSharingStore(sqlExecutor(this.ctx.storage))
    this.runtime = new NativeSharingSessionRuntime(this.store)
    this.ctx.blockConcurrencyWhile(async () => {
      this.store.initializeSchema()
    })
  }

  private ensureSchema(): void {
    if (!this.schemaDeleted) return
    this.store.initializeSchema()
    this.schemaDeleted = false
  }

  private async deleteAllAndVerify(): Promise<boolean> {
    await this.ctx.storage.deleteAll()
    this.schemaDeleted = true
    const alarm = await this.ctx.storage.getAlarm()
    const tables = this.ctx.storage.sql.exec<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (
         'sharing_session', 'accepted_points', 'viewer_sessions', 'rate_or_sequence_state'
       )`,
    ).toArray()
    const verified = alarm === null && tables.length === 0
    return this.testCleanupVerificationOverride === false ? false : verified
  }

  async createSession(input: CreateSessionInput): Promise<RpcResult<NativeSharingSession>> {
    this.ensureSchema()
    const result = await this.runtime.createSession(input)
    if (!result.ok) return result
    const deadline = Date.parse(result.value.expiresAt) + DELETE_AFTER_EXPIRATION_MS
    try {
      if (this.testSetAlarmFailure) throw new Error('SYNTHETIC_SET_ALARM_FAILURE')
      await this.ctx.storage.setAlarm(deadline)
      return result
    } catch {
      try {
        const clean = await this.deleteAllAndVerify()
        if (!clean) return { ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }
      } catch {
        return { ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }
      }
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
    const deadline = this.store.deletionDeadlineMs()
    if (deadline === null || Date.now() >= deadline) {
      const clean = await this.deleteAllAndVerify()
      if (!clean) throw new Error('STORAGE_CLEANUP_UNVERIFIED')
      return
    }
    await this.ctx.storage.setAlarm(deadline)
  }
}
