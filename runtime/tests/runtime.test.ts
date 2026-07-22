import { describe, expect, test } from 'bun:test'
import type { SessionStore, StoredSessionRecord } from '../src/contracts'
import { decryptSession, encryptSession, hashIdentitySubject } from '../src/crypto'
import { createRuntime } from '../src/index'
import { CRITICAL_COOKIE_NAMES, parseCookieInput, parseLocationSharingResponse } from '../src/session'

const NOW = new Date('2026-07-22T03:00:00.000Z')
const SECRET = 'synthetic-session-encryption-key-00000000000000000000'
const SYNTHETIC_COOKIES = CRITICAL_COOKIE_NAMES.map((name, index) => ({
  name,
  value: `synthetic-cookie-${index}`,
  domain: '.google.com',
  path: '/',
  secure: true,
}))

class MemoryStore implements SessionStore {
  records = new Map<string, StoredSessionRecord>()
  async get(subjectHash: string) { return this.records.get(subjectHash) ?? null }
  async put(record: StoredSessionRecord) { this.records.set(record.subjectHash, record) }
  async delete(subjectHash: string) { this.records.delete(subjectHash) }
}

function googleOk(point = true): typeof fetch {
  return async () => new Response(
    point
      ? `)]}'\n[null,20.5678,10.1234],[0,77],1,null,[0],1711111111111,18,"synthetic"`
      : `)]}'\n["locationsharing",null]`,
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function runtime(store: MemoryStore, subject = 'identity-user-a', fetchGoogle: typeof fetch = googleOk()) {
  return createRuntime({
    validateIdentity: async () => ({ sub: subject, email: 'synthetic@example.test' }),
    fetchGoogle,
    storeFactory: () => store,
    now: () => NOW,
  })
}

function env() {
  return {
    ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
    ACCESS_AUD: 'synthetic-audience',
    SESSION_ENCRYPTION_KEY: SECRET,
    SESSION_DB: {} as never,
    STRACKER_SERVICE_TOKEN: 'synthetic-internal-token-not-a-google-session',
  }
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://stracker.invalid${path}`, init)
}

async function payload(response: Response) {
  return response.json() as Promise<Record<string, unknown>>
}

describe('identity and Google Maps session separation', () => {
  test('GOOGLE_LOGIN_DOES_NOT_UNLOCK_SHARED_LOCATION', async () => {
    const app = runtime(new MemoryStore())
    const status = await app.fetch(request('/api/session/status'), env())
    expect(status.status).toBe(200)
    expect((await payload(status)).state).toBe('SHARED_UNCONFIGURED')

    const points = await app.fetch(request('/points'), env())
    expect(points.status).toBe(409)
    expect((await payload(points)).error).toBe('SHARED_SESSION_REQUIRED')
  })

  test('SHARED_SESSION_REQUIRED and session is scoped to Access subject', async () => {
    const store = new MemoryStore()
    const first = runtime(store, 'identity-user-a')
    const imported = await first.fetch(request('/api/session/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: JSON.stringify(SYNTHETIC_COOKIES) }),
    }), env())
    expect(imported.status).toBe(200)
    expect((await payload(imported)).state).toBe('SHARED_READY')

    const firstPoints = await first.fetch(request('/points'), env())
    expect(firstPoints.status).toBe(200)
    expect(((await payload(firstPoints)).points as unknown[]).length).toBe(1)

    const second = runtime(store, 'identity-user-b')
    const secondPoints = await second.fetch(request('/points'), env())
    expect(secondPoints.status).toBe(409)
  })

  test('IDENTITY_AND_SESSION_SEPARATED and encrypted storage contains no cookie values or service token', async () => {
    const store = new MemoryStore()
    const app = runtime(store)
    await app.fetch(request('/api/session/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: JSON.stringify(SYNTHETIC_COOKIES) }),
    }), env())
    expect(store.records.size).toBe(1)
    const record = [...store.records.values()][0]
    expect(record.ciphertextB64).not.toContain('synthetic-cookie')
    expect(record.ciphertextB64).not.toContain('synthetic-internal-token')
    expect(record.subjectHash).not.toContain('identity-user-a')
  })

  test('Google Maps session can expire while Access identity remains accepted', async () => {
    const store = new MemoryStore()
    const linked = runtime(store)
    await linked.fetch(request('/api/session/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: JSON.stringify(SYNTHETIC_COOKIES) }),
    }), env())
    const expired = runtime(store, 'identity-user-a', async () => new Response('expired', { status: 403 }))
    const status = await expired.fetch(request('/api/session/status'), env())
    expect(status.status).toBe(200)
    expect((await payload(status)).state).toBe('SHARED_EXPIRED')
  })

  test('revoked Access identity blocks an otherwise stored session', async () => {
    const store = new MemoryStore()
    const linked = runtime(store)
    await linked.fetch(request('/api/session/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: JSON.stringify(SYNTHETIC_COOKIES) }),
    }), env())
    const denied = createRuntime({
      validateIdentity: async () => { throw new Error('revoked') },
      fetchGoogle: googleOk(),
      storeFactory: () => store,
      now: () => NOW,
    })
    const response = await denied.fetch(request('/api/session/status'), env())
    expect(response.status).toBe(403)
  })
})

describe('session parsing and Web Crypto', () => {
  test('parses Cookie Editor JSON and keeps only sanitized summary public', () => {
    const parsed = parseCookieInput(JSON.stringify(SYNTHETIC_COOKIES), NOW.getTime())
    expect(parsed.formatDetected).toBe('cookie_editor_json')
    expect(parsed.criticalMissing).toEqual([])
    expect(parsed.cookies.length).toBe(CRITICAL_COOKIE_NAMES.length)
  })

  test('parses synthetic Google response with remote timestamp', () => {
    const point = parseLocationSharingResponse(`[null,20.5678,10.1234],1711111111111,18,"synthetic"`, NOW.toISOString())
    expect(point?.lat).toBe(10.1234)
    expect(point?.lng).toBe(20.5678)
    expect(point?.timestamp).toBe('2024-03-22T12:38:31.111Z')
  })

  test('AES-GCM round-trip is bound to the hashed identity subject', async () => {
    const subjectHash = await hashIdentitySubject('identity-user-a')
    const encrypted = await encryptSession('synthetic plaintext', SECRET, subjectHash)
    expect(encrypted.ciphertextB64).not.toContain('synthetic plaintext')
    expect(await decryptSession(encrypted.ivB64, encrypted.ciphertextB64, SECRET, subjectHash)).toBe('synthetic plaintext')
    await expect(decryptSession(encrypted.ivB64, encrypted.ciphertextB64, SECRET, await hashIdentitySubject('identity-user-b'))).rejects.toThrow()
  })
})
