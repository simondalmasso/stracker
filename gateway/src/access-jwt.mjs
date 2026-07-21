const DEFAULT_CLOCK_SKEW_SECONDS = 60
const DEFAULT_JWKS_TTL_MS = 5 * 60 * 1000
const jwksCache = new Map()

export class AccessJwtError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AccessJwtError'
    this.code = code
  }
}

function decodeBase64UrlBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  let binary
  try {
    binary = atob(padded)
  } catch {
    throw new AccessJwtError('MALFORMED_JWT', 'Malformed Access JWT.')
  }
  const output = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index)
  }
  return output
}

function decodeJsonSegment(value) {
  const bytes = decodeBase64UrlBytes(value)
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new AccessJwtError('MALFORMED_JWT', 'Malformed Access JWT payload.')
  }
}

export function normalizeTeamDomain(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AccessJwtError('ACCESS_CONFIG_INVALID', 'Access team domain is missing.')
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new AccessJwtError('ACCESS_CONFIG_INVALID', 'Access team domain is invalid.')
  }
  const hostname = url.hostname.toLowerCase()
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !hostname.endsWith('.cloudflareaccess.com') ||
    hostname === 'cloudflareaccess.com'
  ) {
    throw new AccessJwtError('ACCESS_CONFIG_INVALID', 'Access team domain is not allowed.')
  }
  return url.origin
}

function audienceMatches(claim, expected) {
  if (typeof claim === 'string') return claim === expected
  return Array.isArray(claim) && claim.some((entry) => entry === expected)
}

async function loadJwks(teamDomain, fetchImpl, ttlMs) {
  const jwksUrl = `${teamDomain}/cdn-cgi/access/certs`
  const now = Date.now()
  const cached = jwksCache.get(jwksUrl)
  if (ttlMs > 0 && cached && cached.expiresAt > now) return cached.value

  let response
  try {
    response = await fetchImpl(jwksUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
    })
  } catch {
    throw new AccessJwtError('JWKS_UNAVAILABLE', 'Access signing keys are unavailable.')
  }
  if (!response.ok) {
    throw new AccessJwtError('JWKS_UNAVAILABLE', 'Access signing keys are unavailable.')
  }
  const payload = await response.json().catch(() => null)
  if (!payload || !Array.isArray(payload.keys)) {
    throw new AccessJwtError('JWKS_INVALID', 'Access signing keys are invalid.')
  }
  if (ttlMs > 0) {
    jwksCache.set(jwksUrl, { value: payload, expiresAt: now + ttlMs })
  }
  return payload
}

export async function validateAccessJwt(token, options) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new AccessJwtError('ACCESS_JWT_MISSING', 'Cloudflare Access JWT is required.')
  }
  if (!options || typeof options !== 'object') {
    throw new AccessJwtError('ACCESS_CONFIG_INVALID', 'Access validation is not configured.')
  }

  const teamDomain = normalizeTeamDomain(options.teamDomain)
  const audience = options.audience
  if (typeof audience !== 'string' || !audience.trim()) {
    throw new AccessJwtError('ACCESS_CONFIG_INVALID', 'Access audience is missing.')
  }

  const parts = token.split('.')
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new AccessJwtError('MALFORMED_JWT', 'Malformed Access JWT.')
  }
  const header = decodeJsonSegment(parts[0])
  const payload = decodeJsonSegment(parts[1])
  if (!header || typeof header !== 'object' || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new AccessJwtError('JWT_ALGORITHM_REJECTED', 'Access JWT algorithm or key is invalid.')
  }
  if (!payload || typeof payload !== 'object') {
    throw new AccessJwtError('MALFORMED_JWT', 'Malformed Access JWT payload.')
  }

  const fetchImpl = options.fetchImpl || fetch
  const jwks = await loadJwks(teamDomain, fetchImpl, options.jwksTtlMs ?? DEFAULT_JWKS_TTL_MS)
  const key = jwks.keys.find((candidate) => (
    candidate &&
    typeof candidate === 'object' &&
    candidate.kid === header.kid &&
    candidate.kty === 'RSA' &&
    (!candidate.alg || candidate.alg === 'RS256') &&
    (!candidate.use || candidate.use === 'sig')
  ))
  if (!key) throw new AccessJwtError('JWT_KEY_NOT_FOUND', 'Access JWT signing key was not found.')

  let cryptoKey
  try {
    cryptoKey = await crypto.subtle.importKey(
      'jwk',
      key,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
  } catch {
    throw new AccessJwtError('JWKS_INVALID', 'Access signing key could not be imported.')
  }

  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  const signature = decodeBase64UrlBytes(parts[2])
  const validSignature = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    cryptoKey,
    signature,
    signingInput,
  )
  if (!validSignature) throw new AccessJwtError('JWT_SIGNATURE_INVALID', 'Access JWT signature is invalid.')

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  const skewSeconds = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS
  if (payload.iss !== teamDomain) throw new AccessJwtError('JWT_ISSUER_INVALID', 'Access JWT issuer is invalid.')
  if (!audienceMatches(payload.aud, audience)) throw new AccessJwtError('JWT_AUDIENCE_INVALID', 'Access JWT audience is invalid.')
  if (typeof payload.exp !== 'number' || payload.exp < nowSeconds - skewSeconds) {
    throw new AccessJwtError('JWT_EXPIRED', 'Access JWT is expired.')
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds + skewSeconds) {
    throw new AccessJwtError('JWT_NOT_ACTIVE', 'Access JWT is not active yet.')
  }
  if (typeof payload.iat === 'number' && payload.iat > nowSeconds + skewSeconds) {
    throw new AccessJwtError('JWT_IAT_INVALID', 'Access JWT issued-at time is invalid.')
  }

  return payload
}

export function clearAccessJwksCache() {
  jwksCache.clear()
}
