import { describe, expect, test } from 'bun:test'
import {
  CookieSessionMemoryRuntime,
  COOKIE_POLICY_VERSION,
  parseCookieSession,
  type CookieProbe,
} from '../../native-sharing-cloudflare/src/cookie-session'

const SESSION_ID = 's'.repeat(43)
const OWNER_TOKEN = 'o'.repeat(43)
const NOW = Date.now()
const AUTH_EXPIRY_S = (NOW + 3_600_000) / 1000
const ANCILLARY_EXPIRY_S = (NOW + 60_000) / 1000
const PAST_S = (NOW - 3_600_000) / 1000

const jsonFixture = JSON.stringify([
  { name: 'SID', value: 'synthetic-sid', domain: '.google.com', path: '/', secure: true, httpOnly: true, expirationDate: AUTH_EXPIRY_S, sameSite: null, storeId: null, hostOnly: false, session: false },
  { name: 'SAPISID', value: 'synthetic-sapisid', domain: 'www.google.com', path: '/', secure: true, expirationDate: AUTH_EXPIRY_S + 60.25 },
])
const readyProbe: CookieProbe = async () => ({ ok: true, state: 'ready', point: { lat: -31.64, lng: -60.71, accuracyM: null, capturedAt: new Date(NOW).toISOString() } })

describe('cookie parser v3', () => {
  test('accepts real Cookie Editor auxiliary fields, nulls and decimal expiration', () => {
    const parsed = parseCookieSession(jsonFixture)
    expect(parsed.format).toBe('COOKIE_EDITOR_JSON')
    expect(parsed.cookies.length).toBe(2)
    expect(parsed.cookies[0]?.httpOnly).toBe(true)
    expect(parsed.retainedCount).toBe(2)
  })

  test('accepts wrapped JSON, map, header and Netscape formats', () => {
    expect(parseCookieSession(JSON.stringify({ data: JSON.parse(jsonFixture) })).format).toBe('WRAPPED_JSON')
    expect(parseCookieSession(JSON.stringify({ SID: 'synthetic', SAPISID: 'synthetic-2' })).format).toBe('JSON_NAME_VALUE_MAP')
    expect(parseCookieSession('SID=synthetic; SAPISID=synthetic-2').format).toBe('COOKIE_HEADER_STRING')
    const netscape = `# Netscape HTTP Cookie File\n.google.com\tTRUE\t/\tTRUE\t${AUTH_EXPIRY_S}\tSID\tsynthetic\n.google.com\tTRUE\t/\tTRUE\t${AUTH_EXPIRY_S}\tSAPISID\tsynthetic-2`
    expect(parseCookieSession(netscape).format).toBe('NETSCAPE')
  })

  test('rejects broken, foreign or incomplete inputs without leaking values', () => {
    expect(() => parseCookieSession('[broken')).toThrow('COOKIE_FORMAT_UNRECOGNIZED')
    const secret = 'must-not-escape'
    try { parseCookieSession(JSON.stringify([{ name: 'SID', value: secret, domain: '.example.com' }])) }
    catch (error) { expect(String(error)).not.toContain(secret) }
    expect(() => parseCookieSession('foo=bar')).toThrow('COOKIE_SET_INCOMPLETE')
  })

  test('drops already-expired ancillary rows but does not use ancillary expiry as global auth expiry', () => {
    const parsed = parseCookieSession(JSON.stringify([
      { name: 'SID', value: 'current-auth', domain: '.google.com', expirationDate: AUTH_EXPIRY_S },
      { name: 'NID', value: 'stale-ancillary', domain: '.google.com', expirationDate: PAST_S },
    ]))
    expect(parsed.expiredDropped).toBe(1)
    expect(parsed.cookies.map((cookie) => cookie.name)).toEqual(['SID'])
    expect(parsed.expiresAt).toBe(AUTH_EXPIRY_S * 1000)
  })

  test('early-expiring valid ancillary cookie cannot shorten auth lifetime', () => {
    const parsed = parseCookieSession(JSON.stringify([
      { name: 'SID', value: 'current-auth', domain: '.google.com', expirationDate: AUTH_EXPIRY_S },
      { name: 'NID', value: 'ancillary', domain: '.google.com', expirationDate: ANCILLARY_EXPIRY_S },
    ]))
    expect(parsed.expiresAt).toBe(AUTH_EXPIRY_S * 1000)
  })
})

describe('cookie runtime continuity', () => {
  test('requires probe confirmation, exposes metadata only and explicit delete revokes', async () => {
    const runtime = new CookieSessionMemoryRuntime(readyProbe, () => NOW)
    const imported = await runtime.importSession({ sessionId: SESSION_ID, ownerToken: OWNER_TOKEN, raw: jsonFixture, durationMs: 30 * 60_000 })
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.value.policyVersion).toBe(COOKIE_POLICY_VERSION)
    expect(imported.value.expiresAt).toBe(new Date(NOW + 30 * 60_000).toISOString())
    expect(JSON.stringify(imported.value)).not.toContain('synthetic-sid')
    const point = await runtime.point(SESSION_ID, OWNER_TOKEN)
    expect(point.ok && point.value.point?.lat).toBe(-31.64)
    expect((await runtime.delete(SESSION_ID, OWNER_TOKEN)).ok).toBe(true)
    expect((await runtime.status(SESSION_ID, OWNER_TOKEN)).ok).toBe(false)
  })

  test('transient provider failure does not delete session, real auth failure does', async () => {
    let now = NOW
    let mode: 'ready' | 'transient' | 'auth' = 'ready'
    const probe: CookieProbe = async () => mode === 'ready'
      ? { ok: true, state: 'ready', point: { lat: -31.64, lng: -60.71, accuracyM: null, capturedAt: new Date(now).toISOString() } }
      : mode === 'transient'
        ? { ok: false, status: 503, code: 'COOKIE_PROVIDER_UNAVAILABLE' }
        : { ok: false, status: 401, code: 'COOKIE_AUTH_EXPIRED' }
    const runtime = new CookieSessionMemoryRuntime(probe, () => now)
    expect((await runtime.importSession({ sessionId: SESSION_ID, ownerToken: OWNER_TOKEN, raw: jsonFixture, durationMs: 30 * 60_000 })).ok).toBe(true)
    now += 11_000; mode = 'transient'
    expect(await runtime.refresh(SESSION_ID, OWNER_TOKEN)).toEqual({ ok: false, status: 503, code: 'COOKIE_PROVIDER_UNAVAILABLE' })
    expect((await runtime.status(SESSION_ID, OWNER_TOKEN)).ok).toBe(true)
    now += 11_000; mode = 'auth'
    expect(await runtime.refresh(SESSION_ID, OWNER_TOKEN)).toEqual({ ok: false, status: 401, code: 'COOKIE_AUTH_EXPIRED' })
    expect((await runtime.status(SESSION_ID, OWNER_TOKEN)).ok).toBe(false)
  })
})
