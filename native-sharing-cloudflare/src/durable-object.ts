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
import { enrichCookieHistoryWithRoadNetwork } from './cookie-road-network.js'
import { probeGoogleCookieSessionV2 } from './cookie-provider-probe.js'
import { DurableCookieSessionRuntime, type CookieHistoryResponse } from './cookie-session-durable.js'
import { SqliteCookieSessionStore } from './cookie-session-store.js'
import type { CookieSessionImportInput, CookieSessionPointResponse, CookieSessionPublicStatus } from './cookie-session.js'
import type { RpcResult } from './runtime-contracts.js'
import { NativeSharingSessionRuntime } from './session-runtime.js'
import type { RuntimeSqlExecutor, RuntimeSqlRow, RuntimeSqlValue } from './sqlite-store.js'
import { SqliteNativeSharingStore } from './sqlite-store.js'

function sqlExecutor(storage: DurableObjectStorage): RuntimeSqlExecutor {
  return {
    exec<T extends RuntimeSqlRow = RuntimeSqlRow>(query: string, ...bindings: RuntimeSqlValue[]) {
      return storage.sql.exec<T>(query, ...bindings)
    },
    logicalRowsWritten(): number {
      const row = storage.sql.exec<{ logical_rows_written: number }>('SELECT changes() AS logical_rows_written').toArray()[0]
      return Number(row?.logical_rows_written ?? 0)
    },
    transactionSync<T>(callback: () => T): T {
      return storage.transactionSync(callback)
    },
  }
}

export class NativeSharingDurableObject extends DurableObject<Env> {
  private readonly store: SqliteNativeSharingStore
  private readonly runtime: NativeSharingSessionRuntime
  private readonly cookieStore: SqliteCookieSessionStore
  private readonly cookieRuntime: DurableCookieSessionRuntime
  private schemaDeleted = false
  private testCleanupVerificationOverride: false | null = null
  private testSetAlarmFailure = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const sql = sqlExecutor(this.ctx.storage)
    this.store = new SqliteNativeSharingStore(sql)
    this.runtime = new NativeSharingSessionRuntime(this.store)
    this.cookieStore = new SqliteCookieSessionStore(sql)
    const secret = (env as Env & { COOKIE_SESSION_ENCRYPTION_KEY?: string }).COOKIE_SESSION_ENCRYPTION_KEY ?? ''
    this.cookieRuntime = new DurableCookieSessionRuntime(this.cookieStore, secret, probeGoogleCookieSessionV2)
    this.ctx.blockConcurrencyWhile(async () => {
      this.store.initializeSchema()
      this.cookieStore.initializeSchema()
    })
  }

  private ensureSchema(): void {
    if (!this.schemaDeleted) return
    this.store.initializeSchema()
    this.cookieStore.initializeSchema()
    this.schemaDeleted = false
  }

  private async deleteAllAndVerify(): Promise<boolean> {
    await this.ctx.storage.deleteAll()
    this.schemaDeleted = true
    const alarm = await this.ctx.storage.getAlarm()
    this.ensureSchema()
    const native = this.store.storageCounts()
    const cookie = this.cookieStore.storageCounts()
    const verified = alarm === null
      && native.sessions === 0
      && native.points === 0
      && native.viewers === 0
      && native.sequenceStates === 0
      && cookie.sessions === 0
      && cookie.points === 0
      && cookie.mobilityCells === 0
      && cookie.mobilityTransitions === 0
    return this.testCleanupVerificationOverride === false ? false : verified
  }

  private async scheduleNextAlarm(): Promise<void> {
    const deadlines = [this.store.deletionDeadlineMs(), this.cookieRuntime.nextAlarmAtMs()]
      .filter((value): value is number => value !== null && Number.isFinite(value))
    if (!deadlines.length) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    if (this.testSetAlarmFailure) throw new Error('SYNTHETIC_SET_ALARM_FAILURE')
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 250, Math.min(...deadlines)))
  }

  async createSession(input: CreateSessionInput): Promise<RpcResult<NativeSharingSession>> {
    this.ensureSchema()
    const result = await this.runtime.createSession(input)
    if (!result.ok) return result
    try {
      await this.scheduleNextAlarm()
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

  async importCookieSession(input: CookieSessionImportInput): Promise<RpcResult<CookieSessionPublicStatus>> {
    this.ensureSchema()
    const result = await this.cookieRuntime.importSession(input)
    if (!result.ok) return result
    try {
      await this.scheduleNextAlarm()
      return result
    } catch {
      this.cookieStore.deleteSessionData(input.sessionId)
      return { ok: false, status: 503, code: 'STORAGE_UNAVAILABLE' }
    }
  }

  getCookieSessionStatus(sessionId: string, ownerToken: string): Promise<RpcResult<CookieSessionPublicStatus>> {
    return this.cookieRuntime.status(sessionId, ownerToken)
  }

  getCookieSessionPoint(sessionId: string, ownerToken: string): Promise<RpcResult<CookieSessionPointResponse>> {
    return this.cookieRuntime.point(sessionId, ownerToken)
  }

  async getCookieSessionHistory(sessionId: string, ownerToken: string, sinceIso: string): Promise<RpcResult<CookieHistoryResponse>> {
    const result = await this.cookieRuntime.history(sessionId, ownerToken, sinceIso)
    if (!result.ok) return result
    return { ok: true, value: await enrichCookieHistoryWithRoadNetwork(result.value) }
  }

  async refreshCookieSession(sessionId: string, ownerToken: string): Promise<RpcResult<CookieSessionPublicStatus>> {
    const result = await this.cookieRuntime.refresh(sessionId, ownerToken)
    await this.scheduleNextAlarm().catch(() => undefined)
    return result
  }

  clearCookieMobility(sessionId: string, ownerToken: string): Promise<RpcResult<null>> {
    return this.cookieRuntime.clearMobility(sessionId, ownerToken)
  }

  async deleteCookieSession(sessionId: string, ownerToken: string): Promise<RpcResult<null>> {
    const result = await this.cookieRuntime.delete(sessionId, ownerToken)
    if (result.ok) await this.scheduleNextAlarm().catch(() => undefined)
    return result
  }

  async alarm(): Promise<void> {
    this.ensureSchema()
    const nativeDeadline = this.store.deletionDeadlineMs()
    await this.cookieRuntime.onAlarm()
    await this.store.deleteExpired(new Date().toISOString())
    if (this.testCleanupVerificationOverride === false && nativeDeadline !== null && Date.now() >= nativeDeadline) throw new Error('STORAGE_CLEANUP_UNVERIFIED')
    await this.scheduleNextAlarm()
  }
}
