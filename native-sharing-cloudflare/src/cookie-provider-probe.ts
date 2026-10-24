import type { CookieProbeResult, NormalizedCookie } from './cookie-session.js'
import { extractProviderPoints } from './cookie-provider-payload.js'

const PROVIDER_TIMEOUT_MS = 8_000
const PROVIDER_URL = 'https://www.google.com/maps/rpc/locationsharing/read?authuser=0&hl=es&gl=ar&pb='

function providerCookieHeader(cookies: readonly NormalizedCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

export async function probeGoogleCookieSessionV2(cookies: readonly NormalizedCookie[]): Promise<CookieProbeResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort('PROVIDER_TIMEOUT'), PROVIDER_TIMEOUT_MS)
  try {
    const response = await fetch(PROVIDER_URL, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        Cookie: providerCookieHeader(cookies),
        Referer: 'https://www.google.com/maps',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36',
        'X-Goog-AuthUser': '0',
      },
    })
    const location = response.headers.get('Location') ?? ''
    if (response.status === 401 || response.status === 403 || location.includes('accounts.google.com')) return { ok: false, status: 401, code: 'COOKIE_AUTH_EXPIRED' }
    if (response.status >= 500 || response.status === 429) return { ok: false, status: 503, code: 'COOKIE_PROVIDER_UNAVAILABLE' }
    const body = (await response.text()).slice(0, 1_000_000)
    if (body.includes('accounts.google.com/ServiceLogin') || body.includes('signin/v2')) return { ok: false, status: 401, code: 'COOKIE_AUTH_EXPIRED' }
    if (!response.ok) return { ok: false, status: 503, code: 'COOKIE_PROVIDER_UNAVAILABLE' }
    const observedAt = new Date().toISOString()
    const points = extractProviderPoints(body, observedAt)
    const point = points.length ? points[points.length - 1] : null
    return point ? { ok: true, state: 'ready', point, points } : { ok: true, state: 'no_location', point: null, points: [] }
  } catch {
    return { ok: false, status: 503, code: 'COOKIE_PROVIDER_UNAVAILABLE' }
  } finally {
    clearTimeout(timeout)
  }
}
