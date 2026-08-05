import { parseViewerCapabilityValue } from './native-sharing-api'

export const STRACKER_PUBLIC_ORIGIN = 'https://stracker.simondalmasso44.workers.dev'

export interface AuthorizedViewerLink {
  capability: string
  sessionId: string
  viewerToken: string
  normalizedUrl: string
}

function authorizedOrigin(candidate: string): URL {
  const fallback = new URL(STRACKER_PUBLIC_ORIGIN)
  try {
    const parsed = new URL(candidate)
    if (parsed.origin === fallback.origin) return fallback
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'
    if (loopback && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) return parsed
  } catch {
    // Production remains fail-closed to the canonical runtime.
  }
  return fallback
}

export function parseAuthorizedViewerLink(value: string, runtimeOrigin = STRACKER_PUBLIC_ORIGIN): AuthorizedViewerLink | null {
  const raw = value.trim()
  if (!/^https?:\/\//i.test(raw)) return null

  const allowed = authorizedOrigin(runtimeOrigin)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  if (url.origin !== allowed.origin) return null
  if (url.username || url.password) return null
  if (allowed.origin === STRACKER_PUBLIC_ORIGIN && url.protocol !== 'https:') return null
  if (url.pathname !== '/shared' && url.pathname !== '/shared/') return null
  if (url.search) return null

  const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash)
  if ([...fragment.keys()].some((key) => key !== 'v')) return null
  const values = fragment.getAll('v')
  if (values.length !== 1) return null

  const parsed = parseViewerCapabilityValue(values[0])
  if (!parsed) return null
  return {
    ...parsed,
    normalizedUrl: `${allowed.origin}/shared#v=${encodeURIComponent(parsed.capability)}`,
  }
}
