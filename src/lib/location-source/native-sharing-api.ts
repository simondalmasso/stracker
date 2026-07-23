import type {
  AcceptedNativeSharedLocationPoint,
  NativeCreateSessionResponse,
  NativeSharedLocationPoint,
  NativeViewerExchangeResponse,
  NativeViewerPoints,
  NativeViewerStatus,
} from './contracts'

const CAPABILITY_PATTERN = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/

export class NativeSharingApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'NativeSharingApiError'
  }
}

export function parseViewerCapabilityValue(value: string): { capability: string; sessionId: string; viewerToken: string } | null {
  const raw = value.trim()
  const direct = CAPABILITY_PATTERN.exec(raw)
  if (direct) return { capability: raw, sessionId: direct[1], viewerToken: direct[2] }

  try {
    const url = new URL(raw, 'https://stracker.invalid')
    if (url.pathname !== '/shared' && url.pathname !== '/shared/') return null
    if (url.search) return null
    const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash)
    if ([...fragment.keys()].some((key) => key !== 'v')) return null
    const values = fragment.getAll('v')
    if (values.length !== 1) return null
    const match = CAPABILITY_PATTERN.exec(values[0])
    return match ? { capability: values[0], sessionId: match[1], viewerToken: match[2] } : null
  } catch {
    return null
  }
}

export function viewerFragmentLink(viewerCapability: string, origin = ''): string {
  const parsed = parseViewerCapabilityValue(viewerCapability)
  if (!parsed) throw new Error('INVALID_VIEWER_CAPABILITY')
  return `${origin}/shared#v=${encodeURIComponent(parsed.capability)}`
}

export function readViewerCapabilityFromFragment(): string | null {
  if (typeof window === 'undefined') return null
  const fragment = new URLSearchParams(window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash)
  if ([...fragment.keys()].some((key) => key !== 'v')) return null
  const values = fragment.getAll('v')
  if (values.length !== 1) return null
  return parseViewerCapabilityValue(values[0])?.capability ?? null
}

export function removeViewerCapabilityFragment(): void {
  if (typeof window === 'undefined') return
  window.history.replaceState(null, '', '/shared')
}

async function parseJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as (T & { error?: string; message?: string }) | null
  if (!response.ok) throw new NativeSharingApiError(response.status, payload?.error || `HTTP_${response.status}`, payload?.message || 'No se pudo completar la operación.')
  if (!payload) throw new NativeSharingApiError(502, 'INVALID_RESPONSE', 'El servidor devolvió una respuesta inválida.')
  return payload
}

function requestInit(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  return { ...init, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' }
}

function viewerAuthorization(viewerSessionToken: string): HeadersInit {
  return { Authorization: `Bearer ${viewerSessionToken}` }
}

export async function createNativeSession(durationMs: number, signal?: AbortSignal): Promise<NativeCreateSessionResponse> {
  const response = await fetch('/api/share/sessions', requestInit({
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ durationMs }),
  }))
  return parseJson<NativeCreateSessionResponse>(response)
}

export async function publishNativePoint(sessionId: string, emitterToken: string, point: NativeSharedLocationPoint, signal?: AbortSignal): Promise<AcceptedNativeSharedLocationPoint> {
  const response = await fetch(`/api/share/sessions/${sessionId}/points`, requestInit({
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'X-Stracker-Emitter': emitterToken },
    body: JSON.stringify(point),
  }))
  const payload = await parseJson<{ status: 'ok'; point: AcceptedNativeSharedLocationPoint }>(response)
  return payload.point
}

export async function exchangeNativeViewerCapability(viewerCapability: string, signal?: AbortSignal): Promise<NativeViewerExchangeResponse> {
  const parsed = parseViewerCapabilityValue(viewerCapability)
  if (!parsed) throw new NativeSharingApiError(400, 'CAPABILITY_INVALID', 'El enlace privado no es válido.')
  const response = await fetch('/api/share/viewer/exchange', requestInit({
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewerCapability: parsed.capability }),
  }))
  return parseJson<NativeViewerExchangeResponse>(response)
}

export async function logoutNativeViewer(sessionId: string, viewerSessionToken: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch('/api/share/viewer/logout', requestInit({
    method: 'POST',
    signal,
    keepalive: true,
    headers: { 'Content-Type': 'application/json', ...viewerAuthorization(viewerSessionToken) },
    body: JSON.stringify({ sessionId }),
  }))
  await parseJson<{ status: 'ok' }>(response)
}

export async function fetchNativeViewerStatus(sessionId: string, viewerSessionToken: string, signal?: AbortSignal): Promise<NativeViewerStatus> {
  const response = await fetch(`/api/share/sessions/${sessionId}/status`, requestInit({
    method: 'GET',
    signal,
    headers: viewerAuthorization(viewerSessionToken),
  }))
  return parseJson<NativeViewerStatus>(response)
}

export async function fetchNativeViewerPoints(sessionId: string, viewerSessionToken: string, signal?: AbortSignal): Promise<NativeViewerPoints> {
  const response = await fetch(`/api/share/sessions/${sessionId}/points`, requestInit({
    method: 'GET',
    signal,
    headers: viewerAuthorization(viewerSessionToken),
  }))
  return parseJson<NativeViewerPoints>(response)
}

export async function rotateNativeViewer(sessionId: string, emitterToken: string, signal?: AbortSignal): Promise<{ viewerCapability: string; viewerGeneration: number }> {
  const response = await fetch(`/api/share/sessions/${sessionId}/rotate-viewer`, requestInit({
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'X-Stracker-Emitter': emitterToken },
    body: '{}',
  }))
  return parseJson<{ viewerCapability: string; viewerGeneration: number }>(response)
}

export async function revokeNativeSession(sessionId: string, emitterToken: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/api/share/sessions/${sessionId}`, requestInit({
    method: 'DELETE',
    signal,
    headers: { 'X-Stracker-Emitter': emitterToken },
  }))
  await parseJson<{ status: 'ok' }>(response)
}
