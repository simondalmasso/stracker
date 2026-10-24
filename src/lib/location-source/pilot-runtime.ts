import type {
  PilotAccuracyState,
  PilotDiagnosticSummary,
  PilotPermissionState,
  PilotRuntimeIdentity,
} from './contracts'

export const PILOT_RETRY_DELAYS_MS = [1_000, 3_000, 5_000] as const
export const PILOT_REQUEST_TIMEOUT_MS = 12_000

export function pilotAccuracyState(accuracyM: number | null): PilotAccuracyState {
  if (accuracyM === null || !Number.isFinite(accuracyM) || accuracyM < 0) return 'unknown'
  if (accuracyM <= 20) return 'good'
  if (accuracyM <= 50) return 'fair'
  return 'low'
}

export function pilotLastSuccessAgeBucket(lastSuccessAt: string | null, nowMs = Date.now()): string {
  if (!lastSuccessAt) return 'NEVER'
  const timestamp = Date.parse(lastSuccessAt)
  if (!Number.isFinite(timestamp)) return 'UNKNOWN'
  const ageMs = Math.max(0, nowMs - timestamp)
  if (ageMs <= 15_000) return 'FRESH_0_TO_15_SECONDS'
  if (ageMs <= 45_000) return 'DELAYED_16_TO_45_SECONDS'
  return 'STALE_OVER_45_SECONDS'
}

export function pilotHttpStatusCategory(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 200 && value < 300) return 'HTTP_2XX'
    if (value >= 400 && value < 500) return 'HTTP_4XX'
    if (value >= 500 && value < 600) return 'HTTP_5XX'
    return 'HTTP_OTHER'
  }
  if (value instanceof DOMException && value.name === 'AbortError') return 'REQUEST_ABORTED_OR_TIMEOUT'
  if (value instanceof TypeError) return 'NETWORK_ERROR'
  return 'UNKNOWN'
}

export function pilotBrowserAndOsClass(userAgent: string): string {
  const ua = userAgent.toLowerCase()
  const browser = ua.includes('edg/') ? 'EDGE' : ua.includes('chrome/') ? 'CHROME' : 'OTHER_BROWSER'
  const os = ua.includes('android') ? 'ANDROID' : ua.includes('windows') ? 'WINDOWS' : ua.includes('iphone') || ua.includes('ipad') ? 'IOS' : 'OTHER_OS'
  return `${os}_${browser}`
}

export async function pilotPermissionState(): Promise<PilotPermissionState> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unsupported'
  try {
    const result = await navigator.permissions.query({ name: 'geolocation' })
    return result.state
  } catch {
    return 'unknown'
  }
}

export async function fetchPilotRuntimeIdentity(signal?: AbortSignal): Promise<PilotRuntimeIdentity> {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const init: RequestInit = {
    signal,
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    referrerPolicy: 'no-referrer',
  }
  try {
    const [buildResponse, versionResponse] = await Promise.all([
      fetch(`/__stracker/build.json?pilot=${encodeURIComponent(nonce)}`, init),
      fetch(`/__stracker/version.json?pilot=${encodeURIComponent(nonce)}`, init),
    ])
    const build = buildResponse.ok ? await buildResponse.json() as { sourceSha?: string } : null
    const version = versionResponse.ok ? await versionResponse.json() as { sourceSha?: string; versionId?: string } : null
    const sourceSha = build?.sourceSha === version?.sourceSha ? build?.sourceSha || '' : ''
    return {
      buildSha: /^[0-9a-f]{40}$/.test(sourceSha) ? sourceSha : 'UNKNOWN',
      versionId: typeof version?.versionId === 'string' && version.versionId ? version.versionId : 'UNKNOWN',
    }
  } catch {
    return { buildSha: 'UNKNOWN', versionId: 'UNKNOWN' }
  }
}

export async function buildPilotDiagnostic(input: {
  identity: PilotRuntimeIdentity
  wakeLockSupported: boolean
  wakeLockHeld: boolean
  lastHttpStatusCategory: string
  pointAttemptCount: number
  pointSuccessCount: number
  lastSuccessAt: string | null
}): Promise<PilotDiagnosticSummary> {
  const permission = await pilotPermissionState()
  return {
    BUILD_SHA: input.identity.buildSha,
    VERSION_ID: input.identity.versionId,
    BROWSER_AND_OS_CLASS: pilotBrowserAndOsClass(typeof navigator === 'undefined' ? '' : navigator.userAgent),
    PAGE_VISIBILITY_STATE: typeof document === 'undefined' ? 'UNKNOWN' : document.visibilityState.toUpperCase(),
    GEOLOCATION_PERMISSION_STATE: permission,
    NETWORK_ONLINE_STATE: typeof navigator === 'undefined' ? 'UNKNOWN' : navigator.onLine ? 'ONLINE' : 'OFFLINE',
    WAKE_LOCK_SUPPORTED_AND_HELD: `${input.wakeLockSupported ? 'SUPPORTED' : 'UNSUPPORTED'}_${input.wakeLockHeld ? 'HELD' : 'NOT_HELD'}`,
    LAST_HTTP_STATUS_CATEGORY: input.lastHttpStatusCategory,
    POINT_ATTEMPT_COUNT: input.pointAttemptCount,
    POINT_SUCCESS_COUNT: input.pointSuccessCount,
    LAST_SUCCESS_AGE_BUCKET: pilotLastSuccessAgeBucket(input.lastSuccessAt),
  }
}

export function serializePilotDiagnostic(summary: PilotDiagnosticSummary): string {
  return JSON.stringify(summary, null, 2)
}
