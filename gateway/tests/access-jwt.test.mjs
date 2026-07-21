import assert from 'node:assert/strict'
import test from 'node:test'
import { AccessJwtError, clearAccessJwksCache, normalizeTeamDomain, validateAccessJwt } from '../src/access-jwt.mjs'
import { ACCESS_AUD, TEAM_DOMAIN, createAccessFixture } from './helpers.mjs'

test.beforeEach(() => clearAccessJwksCache())

test('validates a correctly signed Cloudflare Access JWT', async () => {
  const fixture = await createAccessFixture()
  const token = await fixture.sign()
  const claims = await validateAccessJwt(token, {
    teamDomain: TEAM_DOMAIN,
    audience: ACCESS_AUD,
    fetchImpl: fixture.jwksFetch,
    jwksTtlMs: 0,
  })
  assert.equal(claims.sub, 'mock-user')
})

test('rejects missing, expired, wrong-audience and wrong-issuer tokens', async () => {
  const fixture = await createAccessFixture()
  const now = Math.floor(Date.now() / 1000)
  const cases = [
    ['', 'ACCESS_JWT_MISSING'],
    [await fixture.sign({ exp: now - 120 }), 'JWT_EXPIRED'],
    [await fixture.sign({ aud: 'wrong-audience' }), 'JWT_AUDIENCE_INVALID'],
    [await fixture.sign({ iss: 'https://other.cloudflareaccess.com' }), 'JWT_ISSUER_INVALID'],
  ]
  for (const [token, code] of cases) {
    await assert.rejects(
      validateAccessJwt(token, { teamDomain: TEAM_DOMAIN, audience: ACCESS_AUD, fetchImpl: fixture.jwksFetch, jwksTtlMs: 0 }),
      (error) => error instanceof AccessJwtError && error.code === code,
    )
  }
})

test('rejects algorithm confusion before key verification', async () => {
  const fixture = await createAccessFixture()
  const token = await fixture.sign({}, { alg: 'none' })
  await assert.rejects(
    validateAccessJwt(token, { teamDomain: TEAM_DOMAIN, audience: ACCESS_AUD, fetchImpl: fixture.jwksFetch, jwksTtlMs: 0 }),
    (error) => error instanceof AccessJwtError && error.code === 'JWT_ALGORITHM_REJECTED',
  )
})

test('locks JWKS retrieval to an exact Cloudflare Access team domain', () => {
  assert.equal(normalizeTeamDomain(`${TEAM_DOMAIN}/`), TEAM_DOMAIN)
  for (const value of [
    'http://stracker-poc.cloudflareaccess.com',
    'https://cloudflareaccess.com',
    'https://stracker-poc.cloudflareaccess.com.evil.invalid',
    'https://user:pass@stracker-poc.cloudflareaccess.com',
    'https://stracker-poc.cloudflareaccess.com/path',
  ]) {
    assert.throws(() => normalizeTeamDomain(value), AccessJwtError)
  }
})
