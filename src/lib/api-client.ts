/**
 * Same-origin API client for STRACKER's transitional architecture.
 *
 * The browser never mints or injects credentials. Cloudflare Access
 * will authenticate the user at the edge; the private Worker gateway
 * will attach the server-only token when proxying to Render.
 */

export interface FetchWithAuthOptions extends RequestInit {
  /** Deprecated compatibility flag; no browser auth header is generated. */
  skipAuth?: boolean
}

function toRequestInit(options: FetchWithAuthOptions): RequestInit {
  const init: FetchWithAuthOptions = { ...options }
  delete init.skipAuth
  return { credentials: 'same-origin', ...init }
}

/** Compatibility name retained for existing callers. */
export async function fetchWithAuth(
  url: string,
  options: FetchWithAuthOptions = {},
): Promise<Response> {
  return fetch(url, toRequestInit(options))
}

export async function apiGet<T = unknown>(
  url: string,
  options?: FetchWithAuthOptions,
): Promise<T> {
  const resp = await fetchWithAuth(url, { ...options, method: 'GET' })
  if (!resp.ok) throw new Error(`apiGet ${url} → HTTP ${resp.status}`)
  return resp.json() as Promise<T>
}

export async function apiPost<T = unknown>(
  url: string,
  body: unknown,
  options?: FetchWithAuthOptions,
): Promise<T> {
  const headers = new Headers(options?.headers)
  headers.set('Content-Type', 'application/json')
  const resp = await fetchWithAuth(url, {
    ...options,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error(`apiPost ${url} → HTTP ${resp.status}`)
  return resp.json() as Promise<T>
}
