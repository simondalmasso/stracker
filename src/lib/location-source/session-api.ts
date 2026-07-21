import type {
  SharedImportResult,
  SharedPointsPayload,
  SharedSessionStatus,
} from './contracts'

const PRIVATE_GATEWAY_MARKER = 'private-poc-v1'

class SessionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'SessionApiError'
  }
}

function assertPrivateGateway(response: Response): void {
  if (response.headers.get('X-Stracker-Gateway') !== PRIVATE_GATEWAY_MARKER) {
    throw new SessionApiError(
      'La ubicación compartida requiere el gateway privado de STRACKER.',
      503,
      'PRIVATE_GATEWAY_REQUIRED',
    )
  }
}

async function parseJson<T>(response: Response): Promise<T> {
  assertPrivateGateway(response)
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string; message?: string })
    | null
  if (!response.ok) {
    const code = payload?.error || `HTTP_${response.status}`
    const message = payload?.message || 'No se pudo completar la operación.'
    throw new SessionApiError(message, response.status, code)
  }
  if (!payload) throw new SessionApiError('Respuesta inválida del servidor.', 502, 'INVALID_RESPONSE')
  return payload
}

function requestInit(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  return {
    ...init,
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
  }
}

export async function getSharedSessionStatus(
  signal?: AbortSignal,
): Promise<SharedSessionStatus> {
  const response = await fetch(
    '/api/session/status',
    requestInit({ method: 'GET', signal }),
  )
  return parseJson<SharedSessionStatus>(response)
}

export async function importSharedSession(
  raw: string,
  signal?: AbortSignal,
): Promise<SharedImportResult> {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const response = await fetch(
    '/api/session/import',
    requestInit({
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({ raw }),
    }),
  )
  return parseJson<SharedImportResult>(response)
}

export async function deleteSharedSession(signal?: AbortSignal): Promise<void> {
  const response = await fetch(
    '/api/session/delete',
    requestInit({ method: 'POST', signal }),
  )
  await parseJson<{ status: 'ok' }>(response)
}

export async function fetchSharedPoints(
  signal?: AbortSignal,
): Promise<SharedPointsPayload> {
  const response = await fetch('/points', requestInit({ method: 'GET', signal }))
  return parseJson<SharedPointsPayload>(response)
}

export { SessionApiError }
