import { describe, expect, test } from 'bun:test'
import { capabilityVerifier } from '../../native-sharing/src/security'
import { extractProviderPoints } from '../../native-sharing-cloudflare/src/cookie-provider-payload'
import { enrichCookieHistoryWithRoadNetwork } from '../../native-sharing-cloudflare/src/cookie-road-network'
import {
  DurableCookieSessionRuntime,
  decryptCookiePayload,
  encryptCookiePayload,
  type CookieHistoryResponse,
} from '../../native-sharing-cloudflare/src/cookie-session-durable'
import { SqliteCookieSessionStore } from '../../native-sharing-cloudflare/src/cookie-session-store'
import type { CookieProbe } from '../../native-sharing-cloudflare/src/cookie-session'
import { BunSqlExecutor } from '../native-sharing-cloudflare/sqlite-test-adapter'

const SESSION_ID = 's'.repeat(43)
const OWNER_TOKEN = 'o'.repeat(43)
const OWNER_VERIFIER = await capabilityVerifier(OWNER_TOKEN)
const SECRET = 'synthetic-cookie-encryption-key-for-tests-only-0001'
const FUTURE_S = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
const RAW = JSON.stringify([
  { name: 'SID', value: 'credential-alpha-never-plaintext-at-rest', domain: '.google.com', path: '/', expirationDate: FUTURE_S },
  { name: 'SAPISID', value: 'credential-beta-never-plaintext-at-rest', domain: '.google.com', path: '/', expirationDate: FUTURE_S },
])

function setup(now: () => Date, probe: CookieProbe) {
  const sql = new BunSqlExecutor()
  const store = new SqliteCookieSessionStore(sql)
  store.initializeSchema()
  const runtime = new DurableCookieSessionRuntime(store, SECRET, probe, now)
  return { sql, store, runtime }
}

describe('provider payload recovery', () => {
  test('recovers every recognized coordinate and uses only plausible nearby provider timestamps', () => {
    const observedAt = '2026-08-16T02:00:00.000Z'
    const firstMs = Date.parse('2026-08-15T23:50:00.000Z')
    const secondMs = Date.parse('2026-08-16T00:10:00.000Z')
    const body = `prefix ${firstMs} [null,-60.7001,-31.6401] middle ${secondMs} [null,[-60.6902,-31.6302]] duplicate [null,[-60.6902,-31.6302]] suffix`
    const points = extractProviderPoints(body, observedAt)
    expect(points.length).toBeGreaterThanOrEqual(2)
    expect(points[0]).toMatchObject({ lat: -31.6401, lng: -60.7001, capturedAt: new Date(firstMs).toISOString(), sourceQuality: 'provider_timestamp' })
    expect(points.some((point) => point.lat === -31.6302 && point.lng === -60.6902 && point.sourceQuality === 'provider_timestamp')).toBe(true)
    expect(points.every((point, index) => index === 0 || Date.parse(point.capturedAt) >= Date.parse(points[index - 1].capturedAt))).toBe(true)
  })

  test('does not invent a provider timestamp when none is present', () => {
    const observedAt = '2026-08-16T02:00:00.000Z'
    expect(extractProviderPoints('x [null,-60.70,-31.64] y', observedAt)).toEqual([{
      lat: -31.64, lng: -60.7, accuracyM: null, capturedAt: observedAt, observedAt, sourceQuality: 'stracker_observed_at',
    }])
  })
})

describe('durable encrypted cookie session', () => {
  test('AES_GCM_ROUND_TRIP_AND_TAMPER_REJECTION', async () => {
    const encrypted = await encryptCookiePayload(SECRET, SESSION_ID, 'sensitive-fixture')
    expect(encrypted.ciphertext).not.toContain('sensitive-fixture')
    expect(await decryptCookiePayload(SECRET, SESSION_ID, encrypted.ciphertext, encrypted.iv)).toBe('sensitive-fixture')
    const tampered = `${encrypted.ciphertext.slice(0, -2)}AA`
    await expect(decryptCookiePayload(SECRET, SESSION_ID, tampered, encrypted.iv)).rejects.toBeTruthy()
  })

  test('survives runtime replacement with ciphertext only and keeps owner isolation', async () => {
    const clock = { value: Date.now() }
    const now = () => new Date(clock.value)
    const probe: CookieProbe = async () => ({ ok: true, state: 'ready', point: { lat: -31.64, lng: -60.70, accuracyM: 9, capturedAt: now().toISOString(), observedAt: now().toISOString(), sourceQuality: 'stracker_observed_at' } })
    const { sql, store, runtime } = setup(now, probe)
    try {
      const imported = await runtime.importSession({ sessionId: SESSION_ID, ownerVerifier: OWNER_VERIFIER, raw: RAW, durationMs: 24 * 60 * 60 * 1000 })
      expect(imported.ok).toBe(true)
      const row = sql.database.query('SELECT cookie_ciphertext, cookie_iv FROM cookie_session LIMIT 1').get() as { cookie_ciphertext: string; cookie_iv: string }
      expect(row.cookie_ciphertext).not.toContain('credential-alpha')
      expect(row.cookie_iv.length).toBeGreaterThan(8)
      const databaseText = JSON.stringify(sql.database.query('SELECT * FROM cookie_session').all())
      expect(databaseText).not.toContain('credential-alpha-never-plaintext-at-rest')
      expect(databaseText).not.toContain('credential-beta-never-plaintext-at-rest')
      const replacement = new DurableCookieSessionRuntime(store, SECRET, probe, now)
      expect((await replacement.status(SESSION_ID, OWNER_TOKEN)).ok).toBe(true)
      const point = await replacement.point(SESSION_ID, OWNER_TOKEN)
      expect(point.ok).toBe(true)
      if (point.ok) expect(point.value.point).toMatchObject({ lat: -31.64, lng: -60.70 })
      expect(await replacement.status(SESSION_ID, 'x'.repeat(43))).toEqual({ ok: false, status: 404, code: 'NOT_FOUND' })
    } finally { sql.close() }
  })

  test('alarm samples while no browser request exists and enforces rolling 24h history', async () => {
    const clock = { value: Date.now() }
    const now = () => new Date(clock.value)
    let probes = 0
    const probe: CookieProbe = async () => {
      probes += 1
      const point = { lat: -31.64 + probes * 0.001, lng: -60.70 + probes * 0.001, accuracyM: 7, capturedAt: now().toISOString(), observedAt: now().toISOString(), sourceQuality: 'stracker_observed_at' as const }
      return { ok: true, state: 'ready', point, points: [point] }
    }
    const { sql, runtime } = setup(now, probe)
    try {
      expect((await runtime.importSession({ sessionId: SESSION_ID, ownerVerifier: OWNER_VERIFIER, raw: RAW, durationMs: 24 * 60 * 60 * 1000 })).ok).toBe(true)
      expect(probes).toBe(1)
      clock.value += 61_000
      await runtime.onAlarm()
      expect(probes).toBe(2)
      const history = await runtime.history(SESSION_ID, OWNER_TOKEN, new Date(clock.value - 24 * 60 * 60 * 1000).toISOString())
      expect(history.ok).toBe(true)
      if (history.ok) {
        expect(history.value.points).toHaveLength(2)
        expect(history.value.points.every((point) => point.provenance === 'observed')).toBe(true)
        expect(history.value.rawRetentionHours).toBe(24)
      }
    } finally { sql.close() }
  })

  test('provider-timestamp backfill stays observed and learned transition prior changes inference confidence', async () => {
    const base = Date.now()
    const now = () => new Date(base + 20 * 60_000)
    const leftAt = new Date(base).toISOString()
    const rightAt = new Date(base + 10 * 60_000).toISOString()
    const probe: CookieProbe = async () => ({
      ok: true, state: 'ready',
      point: { lat: -31.63, lng: -60.69, accuracyM: 8, capturedAt: rightAt, observedAt: now().toISOString(), sourceQuality: 'provider_timestamp' },
      points: [
        { lat: -31.64, lng: -60.70, accuracyM: 8, capturedAt: leftAt, observedAt: now().toISOString(), sourceQuality: 'provider_timestamp' },
        { lat: -31.63, lng: -60.69, accuracyM: 8, capturedAt: rightAt, observedAt: now().toISOString(), sourceQuality: 'provider_timestamp' },
      ],
    })
    const { sql, store, runtime } = setup(now, probe)
    try {
      expect((await runtime.importSession({ sessionId: SESSION_ID, ownerVerifier: OWNER_VERIFIER, raw: RAW, durationMs: 24 * 60 * 60 * 1000 })).ok).toBe(true)
      const points = store.pointsSince(new Date(base - 1000).toISOString())
      expect(points).toHaveLength(2)
      expect(points.every((point) => point.sourceQuality === 'provider_timestamp')).toBe(true)
      const from = `${Math.round(points[0].lat * 1000) / 1000},${Math.round(points[0].lng * 1000) / 1000}`
      const to = `${Math.round(points[1].lat * 1000) / 1000},${Math.round(points[1].lng * 1000) / 1000}`
      const santaFeHour = (new Date(points[0].capturedAt).getUTCHours() + 21) % 24
      const bucket = Math.floor(santaFeHour / 4)
      store.recordMobilityTransition(from, to, bucket, 10 * 60_000, now().toISOString())
      store.recordMobilityTransition(from, to, bucket, 10 * 60_000, now().toISOString())
      store.recordMobilityTransition(from, to, bucket, 10 * 60_000, now().toISOString())
      const history = await runtime.history(SESSION_ID, OWNER_TOKEN, new Date(base - 1000).toISOString())
      expect(history.ok).toBe(true)
      if (history.ok) {
        expect(history.value.segments.find((segment) => segment.provenance === 'inferred')).toMatchObject({ method: 'learned-corridor-prior', confidence: 'high' })
        expect(history.value.keyframes.some((frame) => frame.type === 'data_gap_start')).toBe(true)
        expect(history.value.keyframes.some((frame) => frame.type === 'data_gap_recovered')).toBe(true)
      }
    } finally { sql.close() }
  })

  test('road-network inference supersedes lower-priority linear inference and keeps pre-observation range inferred', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 'Ok', routes: [{ distance: 1500, duration: 600, geometry: { type: 'LineString', coordinates: [[-60.70, -31.64], [-60.695, -31.635], [-60.69, -31.63]] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
    try {
      const start = Date.parse('2026-08-16T00:00:00.000Z')
      const history: CookieHistoryResponse = {
        state: 'ready', windowStart: new Date(start - 60 * 60_000).toISOString(), windowEnd: new Date(start + 20 * 60_000).toISOString(),
        points: [
          { lat: -31.64, lng: -60.70, accuracyM: 8, capturedAt: new Date(start).toISOString(), observedAt: new Date(start).toISOString(), provenance: 'observed', sourceQuality: 'provider_timestamp' },
          { lat: -31.63, lng: -60.69, accuracyM: 8, capturedAt: new Date(start + 10 * 60_000).toISOString(), observedAt: new Date(start + 10 * 60_000).toISOString(), provenance: 'observed', sourceQuality: 'provider_timestamp' },
        ],
        segments: [{ id: 'gap', provenance: 'inferred', confidence: 'low', method: 'generic-plausible-fallback', startedAt: new Date(start).toISOString(), endedAt: new Date(start + 10 * 60_000).toISOString(), points: [{ lat: -31.64, lng: -60.70 }, { lat: -31.63, lng: -60.69 }] }],
        keyframes: [], rawRetentionHours: 24, derivedModelRetentionDays: 30, inferenceTruthLabelRequired: true,
      }
      const enriched = await enrichCookieHistoryWithRoadNetwork(history)
      expect(enriched.segments[0]).toMatchObject({ provenance: 'inferred', confidence: 'low', startedAt: history.windowStart })
      expect(enriched.segments.some((segment) => (segment.method as string) === 'road-network-route' && segment.points.length === 3)).toBe(true)
    } finally { globalThis.fetch = originalFetch }
  })

  test('authentication rejection purges durable ciphertext while retaining only safe metadata/history', async () => {
    const clock = { value: Date.now() }
    const now = () => new Date(clock.value)
    let failAuth = false
    const probe: CookieProbe = async () => failAuth ? { ok: false, status: 401, code: 'COOKIE_AUTH_EXPIRED' } : { ok: true, state: 'no_location', point: null, points: [] }
    const { sql, runtime } = setup(now, probe)
    try {
      expect((await runtime.importSession({ sessionId: SESSION_ID, ownerVerifier: OWNER_VERIFIER, raw: RAW, durationMs: 24 * 60 * 60 * 1000 })).ok).toBe(true)
      failAuth = true
      clock.value += 61_000
      await runtime.onAlarm()
      const stored = sql.database.query('SELECT state, cookie_ciphertext, cookie_iv FROM cookie_session LIMIT 1').get() as { state: string; cookie_ciphertext: string | null; cookie_iv: string | null }
      expect(stored).toEqual({ state: 'auth_expired', cookie_ciphertext: null, cookie_iv: null })
      const status = await runtime.status(SESSION_ID, OWNER_TOKEN)
      expect(status.ok).toBe(true)
      if (status.ok) expect(status.value.state).toBe('auth_expired')
    } finally { sql.close() }
  })
})
