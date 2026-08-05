import { describe, expect, test } from 'bun:test'
import { capabilityVerifier } from '../../native-sharing/src/security'
import {
  CookieSessionMemoryRuntime,
  COOKIE_POLICY_VERSION,
  parseCookieSession,
  type CookieProbe,
} from '../../native-sharing-cloudflare/src/cookie-session'

const SESSION_ID = 's'.repeat(43)
const OWNER_TOKEN = 'o'.repeat(43)
const NOW_S = Math.floor(Date.now() / 1000) + 3600
const jsonFixture = JSON.stringify([
  { name: 'SID', value: 'synthetic-sid', domain: '.google.com', path: '/', secure: true, httpOnly: true, expirationDate: NOW_S },
  { name: 'SAPISID', value: 'synthetic-sapisid', domain: 'www.google.com', path: '/', secure: true, expirationDate: NOW_S },
])

const readyProbe: CookieProbe = async () => ({
  ok: true,
  state: 'ready',
  point: { lat: -31.64, lng: -60.71, accuracyM: null, capturedAt: new Date().toISOString() },
})

describe('cookie parser', () => {
  test('accepts Cookie Editor JSON and preserves safe metadata', () => {
    const parsed = parseCookieSession(jsonFixture)
    expect(parsed.format).toBe('COOKIE_EDITOR_JSON')
    expect(parsed.cookies.length).toBe(2)
    expect(parsed.cookies[0]?.httpOnly).toBe(true)
  })

  test('accepts wrapped JSON, map, header and Netscape formats', () => {
    expect(parseCookieSession(JSON.stringify({ data: JSON.parse(jsonFixture) })).format).toBe('WRAPPED_JSON')
    expect(parseCookieSession(JSON.stringify({ SID: 'synthetic', SAPISID: 'synthetic-2' })).format).toBe('JSON_NAME_VALUE_MAP')
    expect(parseCookieSession('SID=synthetic; SAPISID=synthetic-2').format).toBe('COOKIE_HEADER_STRING')
    const netscape = `# Netscape HTTP Cookie File\n.google.com\tTRUE\t/\tTRUE\t${NOW_S}\tSID\tsynthetic\n.google.com\tTRUE\t/\tTRUE\t${NOW_S}\tSAPISID\tsynthetic-2`
    expect(parseCookieSession(netscape).format).toBe('NETSCAPE')
  })

  test('deduplicates and rejects unsafe or incomplete input', () => {
    const duplicate = JSON.stringify([
      { name: 'SID', value: 'old', domain: '.google.com' },
      { name: 'SID', value: 'new', domain: '.google.com' },
      { name: 'SAPISID', value: 'x', domain: '.google.com' },
    ])
    expect(parseCookieSession(duplicate).cookies.length).toBe(2)
    expect(() => parseCookieSession('foo=bar')).toThrow('COOKIE_SET_INCOMPLETE')
    expect(() => parseCookieSession(JSON.stringify([{ name: 'SID', value: 'x', domain: '.example.com' }]))).toThrow('COOKIE_DOMAIN_REJECTED')
  })
})

describe('memory-only cookie session runtime', () => {
  test('requires real probe confirmation before success and returns metadata only', async () => {
    const runtime = new CookieSessionMemoryRuntime(readyProbe)
    const ownerVerifier = await capabilityVerifier(OWNER_TOKEN)
    const imported = await runtime.importSession({ sessionId: SESSION_ID, ownerVerifier, raw: jsonFixture, durationMs: 60_000 * 30 })
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.value.policyVersion).toBe(COOKIE_POLICY_VERSION)
    expect(imported.value.cookieCount).toBe(2)
    expect(JSON.stringify(imported.value)).not.toContain('synthetic-sid')
    expect(JSON.stringify(imported.value)).not.toContain('point')
    const status = await runtime.status(SESSION_ID, OWNER_TOKEN)
    expect(status.ok).toBe(true)
    if (status.ok) expect(JSON.stringify(status.value)).not.toContain('point')
    const point = await runtime.point(SESSION_ID, OWNER_TOKEN)
    expect(point.ok).toBe(true)
    if (point.ok) expect(point.value.point?.lat).toBe(-31.64)
    const wrongOwner = await runtime.status(SESSION_ID, 'x'.repeat(43))
    expect(wrongOwner).toEqual({ ok: false, status: 404, code: 'NOT_FOUND' })
  })

  test('does not retain credentials after deletion or runtime replacement', async () => {
    const ownerVerifier = await capabilityVerifier(OWNER_TOKEN)
    const runtime = new CookieSessionMemoryRuntime(readyProbe)
    expect((await runtime.importSession({ sessionId: SESSION_ID, ownerVerifier, raw: jsonFixture, durationMs: 60_000 * 30 })).ok).toBe(true)
    expect((await runtime.delete(SESSION_ID, OWNER_TOKEN)).ok).toBe(true)
    expect((await runtime.status(SESSION_ID, OWNER_TOKEN)).ok).toBe(false)
    const replacement = new CookieSessionMemoryRuntime(readyProbe)
    expect((await replacement.status(SESSION_ID, OWNER_TOKEN)).ok).toBe(false)
  })

  test('rejects provider authentication failure without creating a session', async () => {
    const failedProbe: CookieProbe = async () => ({ ok: false, status: 401, code: 'COOKIE_AUTH_EXPIRED' })
    const runtime = new CookieSessionMemoryRuntime(failedProbe)
    const result = await runtime.importSession({ sessionId: SESSION_ID, ownerVerifier: await capabilityVerifier(OWNER_TOKEN), raw: jsonFixture, durationMs: 60_000 * 30 })
    expect(result).toEqual({ ok: false, status: 401, code: 'COOKIE_AUTH_EXPIRED' })
    expect((await runtime.status(SESSION_ID, OWNER_TOKEN)).ok).toBe(false)
  })
})
