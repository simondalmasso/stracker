import type { CreateSessionInput, NativeSharingSession } from '../../native-sharing/src/contracts.js'
import { buildViewerCapability, capabilityVerifier, generateCapability } from '../../native-sharing/src/security.js'
import type {
  NativeSharingNamespaceBinding,
  NativeSharingRpcStub,
  NativeSharingRuntimeBindings,
  RpcResult,
} from '../../native-sharing-cloudflare/src/runtime-contracts.js'
import { NativeSharingSessionRuntime } from '../../native-sharing-cloudflare/src/session-runtime.js'
import { SqliteNativeSharingStore } from '../../native-sharing-cloudflare/src/sqlite-store.js'
import { BunSqlExecutor } from './sqlite-test-adapter.js'

export interface TestSessionObject {
  sql: BunSqlExecutor
  store: SqliteNativeSharingStore
  runtime: NativeSharingSessionRuntime
  stub: NativeSharingRpcStub
}

export function createTestSessionObject(now: () => Date = () => new Date()): TestSessionObject {
  const sql = new BunSqlExecutor()
  const store = new SqliteNativeSharingStore(sql)
  store.initializeSchema()
  const runtime = new NativeSharingSessionRuntime(store, now)
  const stub: NativeSharingRpcStub = {
    createSession: (input) => runtime.createSession(input),
    appendPoint: (sessionId, emitterToken, point) => runtime.appendPoint(sessionId, emitterToken, point),
    exchangeViewerCapability: (capability) => runtime.exchangeViewerCapability(capability),
    getStatus: (sessionId, token) => runtime.getStatus(sessionId, token),
    getPoints: (sessionId, token) => runtime.getPoints(sessionId, token),
    logoutViewer: (sessionId, token) => runtime.logoutViewer(sessionId, token),
    rotateViewer: (sessionId, token) => runtime.rotateViewer(sessionId, token),
    revoke: (sessionId, token) => runtime.revoke(sessionId, token),
  }
  return { sql, store, runtime, stub }
}

export class TestNativeSharingNamespace implements NativeSharingNamespaceBinding {
  readonly objects = new Map<string, TestSessionObject>()
  readonly routedNames: string[] = []

  constructor(private readonly now: () => Date = () => new Date()) {}

  getByName(name: string): NativeSharingRpcStub {
    this.routedNames.push(name)
    let object = this.objects.get(name)
    if (!object) {
      object = createTestSessionObject(this.now)
      this.objects.set(name, object)
    }
    return object.stub
  }

  close(): void {
    for (const object of this.objects.values()) object.sql.close()
  }
}

export function testBindings(namespace = new TestNativeSharingNamespace()): NativeSharingRuntimeBindings {
  return {
    NATIVE_SHARING: namespace,
    ASSETS: {
      async fetch(request: Request) {
        return new Response(`asset:${new URL(request.url).pathname}`, {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      },
    },
  }
}

export async function directSession(
  runtime: NativeSharingSessionRuntime,
  now: Date,
  durationMs = 60 * 60 * 1000,
): Promise<{ input: CreateSessionInput; emitterToken: string; viewerToken: string; viewerCapability: string }> {
  const sessionId = generateCapability()
  const emitterToken = generateCapability()
  const viewerToken = generateCapability()
  const session: NativeSharingSession = {
    id: sessionId,
    emitterVerifier: await capabilityVerifier(emitterToken),
    viewerVerifier: await capabilityVerifier(viewerToken),
    viewerGeneration: 1,
    state: 'active',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + durationMs).toISOString(),
    revokedAt: null,
    lastSequence: 0,
    lastCapturedAt: null,
    lastReceivedAt: null,
    pointCount: 0,
  }
  const input = { session }
  const created = await runtime.createSession(input)
  if (!created.ok) throw new Error(`synthetic session failed: ${created.code}`)
  return { input, emitterToken, viewerToken, viewerCapability: buildViewerCapability(sessionId, viewerToken) }
}

export function expectError<T>(result: RpcResult<T>, code: string): void {
  if (result.ok || result.code !== code) throw new Error(`expected ${code}`)
}
