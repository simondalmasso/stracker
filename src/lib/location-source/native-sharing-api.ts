import type {
  AcceptedNativeSharedLocationPoint,
  NativeCreateSessionResponse,
  NativeSharedLocationPoint,
  NativeViewerPoints,
  NativeViewerStatus,
} from './contracts'

export class NativeSharingApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'NativeSharingApiError'
  }
}

export function parseViewerCapability(value: string): { sessionId: string; viewerToken: string } | null {
  const raw = value.trim()
  const fromUrl = (() => {
    try {
      const url = new URL(raw, typeof window === 'undefined' ? 'https://stracker.invalid' : window.location.origin)
      const match = /^\/shared\/([^/]+)\/?$/.exec(url.pathname)
      return match?.[1] || raw
    } catch {
      return raw
    }
  })()
  const match = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(fromUrl)
  return match ? { sessionId: match[1], viewerToken: match[2] } : null
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
  return { ...init, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' }
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

export async function fetchNativeViewerStatus(sessionId: string, viewerToken: string, signal?: AbortSignal): Promise<NativeViewerStatus> {
  const response = await fetch(`/api/share/sessions/${sessionId}/status`, requestInit({
    method: 'GET',
    signal,
    headers: { 'X-Stracker-Viewer': viewerToken },
  }))
  return parseJson<NativeViewerStatus>(response)
}

export async function fetchNativeViewerPoints(sessionId: string, viewerToken: string, signal?: AbortSignal): Promise<NativeViewerPoints> {
  const response = await fetch(`/api/share/sessions/${sessionId}/points`, requestInit({
    method: 'GET',
    signal,
    headers: { 'X-Stracker-Viewer': viewerToken },
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
