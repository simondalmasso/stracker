import type {
  NormalizedCookie,
  ParsedSession,
  ProbeResult,
  SessionPublicStatus,
  SharedPoint,
} from './contracts'

export const MAX_IMPORT_BYTES = 512 * 1024
export const MAX_GOOGLE_RESPONSE_BYTES = 2 * 1024 * 1024
export const LOCATION_SHARING_URL = 'https://www.google.com/maps/rpc/locationsharing/read?authuser=0&hl=es&gl=ar&pb='

export const CRITICAL_COOKIE_NAMES = [
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-3PSID',
] as const

export class SessionInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action: string,
  ) {
    super(message)
    this.name = 'SessionInputError'
  }
}

function allowedDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/^\./, '')
  return normalized === 'google.com' || normalized.endsWith('.google.com')
}

function parseExpiry(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0' || value === -1 || value === '-1') return null
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed)) throw new SessionInputError('INVALID_EXPIRY', 'Una cookie tiene una fecha de vencimiento inválida.', 'Exportá nuevamente la sesión.')
  return parsed > 0 ? parsed : null
}

function normalizeItem(item: unknown, defaultDomain = '.google.com'): NormalizedCookie {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new SessionInputError('INVALID_COOKIE', 'La sesión contiene una cookie inválida.', 'Usá una exportación compatible.')
  }
  const record = item as Record<string, unknown>
  const name = String(record.name ?? '').trim()
  const value = record.value
  if (!name || typeof value !== 'string' || !value) {
    throw new SessionInputError('INVALID_COOKIE', 'Una cookie no tiene nombre o valor válido.', 'Exportá nuevamente la sesión.')
  }
  const domain = String(record.domain ?? record.host ?? defaultDomain).trim().toLowerCase()
  if (!allowedDomain(domain)) {
    throw new SessionInputError('DOMAIN_NOT_ALLOWED', 'La sesión contiene dominios no permitidos.', 'Importá únicamente cookies de Google Maps.')
  }
  const path = String(record.path ?? '/').startsWith('/') ? String(record.path ?? '/') : '/'
  const sameSite = record.sameSite
  return {
    name,
    value,
    domain,
    path,
    secure: record.secure === undefined ? true : Boolean(record.secure),
    expires: parseExpiry(record.expirationDate ?? record.expires),
    httpOnly: Boolean(record.httpOnly),
    sameSite: sameSite ? String(sameSite) : null,
  }
}

function parseJsonValue(value: unknown): { formatDetected: string; items: unknown[] } {
  if (Array.isArray(value)) return { formatDetected: 'cookie_editor_json', items: value }
  if (!value || typeof value !== 'object') {
    throw new SessionInputError('FORMAT_NOT_RECOGNIZED', 'Formato no reconocido.', 'Usá Cookie Editor JSON, Header String o Netscape.')
  }
  const record = value as Record<string, unknown>
  if (!('data' in record)) {
    throw new SessionInputError('FORMAT_NOT_RECOGNIZED', 'El JSON envuelto no contiene el campo data.', 'Exportá nuevamente la sesión.')
  }
  let wrapped = record.data
  let formatDetected = 'wrapped_json_array'
  if (typeof wrapped === 'string') {
    try {
      wrapped = JSON.parse(wrapped)
    } catch {
      throw new SessionInputError('MALFORMED_JSON', 'El campo data no contiene JSON válido.', 'Corregí el contenido e intentá nuevamente.')
    }
    formatDetected = 'wrapped_json_string'
  }
  if (!Array.isArray(wrapped)) {
    throw new SessionInputError('INVALID_WRAPPED_JSON', 'El campo data debe contener una lista de cookies.', 'Exportá nuevamente la sesión.')
  }
  return { formatDetected, items: wrapped }
}

function parseHeader(raw: string): unknown[] {
  const items: unknown[] = []
  for (const segment of raw.split(';')) {
    const pair = segment.trim()
    if (!pair) continue
    const separator = pair.indexOf('=')
    if (separator <= 0 || separator === pair.length - 1) {
      throw new SessionInputError('MALFORMED_HEADER', 'El Header String contiene un segmento inválido.', 'Copiá el header Cookie completo.')
    }
    items.push({
      name: pair.slice(0, separator).trim(),
      value: pair.slice(separator + 1),
      domain: '.google.com',
      path: '/',
      secure: true,
    })
  }
  return items
}

function parseNetscape(raw: string): unknown[] {
  const items: unknown[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length < 7) {
      throw new SessionInputError('MALFORMED_NETSCAPE', 'El archivo Netscape contiene una línea inválida.', 'Exportá nuevamente el archivo Netscape.')
    }
    const [domain, , path, secure, expires, name, ...valueParts] = parts
    items.push({ domain, path, secure: secure.toUpperCase() === 'TRUE', expires, name, value: valueParts.join('\t') })
  }
  return items
}

export function parseCookieInput(raw: string, nowMs = Date.now()): ParsedSession {
  if (typeof raw !== 'string') throw new SessionInputError('INVALID_BODY', 'El contenido debe ser texto.', 'Pegá una exportación compatible.')
  const bytes = new TextEncoder().encode(raw)
  if (!bytes.byteLength) throw new SessionInputError('EMPTY_INPUT', 'No se recibió ninguna sesión.', 'Pegá una exportación antes de importar.')
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new SessionInputError('INPUT_TOO_LARGE', 'La sesión supera el tamaño permitido.', 'Exportá únicamente las cookies necesarias de Google Maps.')

  const stripped = raw.trim()
  let formatDetected: string
  let items: unknown[]
  if (stripped.startsWith('[') || stripped.startsWith('{')) {
    let decoded: unknown
    try {
      decoded = JSON.parse(stripped)
    } catch {
      throw new SessionInputError('MALFORMED_JSON', 'El JSON no es válido.', 'Corregí el contenido e intentá nuevamente.')
    }
    ;({ formatDetected, items } = parseJsonValue(decoded))
  } else if (stripped.startsWith('# Netscape HTTP Cookie File') || stripped.split(/\r?\n/).some((line) => line.split('\t').length >= 7)) {
    formatDetected = 'netscape'
    items = parseNetscape(stripped)
  } else if (stripped.includes('=')) {
    formatDetected = 'cookie_header'
    items = parseHeader(stripped)
  } else {
    throw new SessionInputError('FORMAT_NOT_RECOGNIZED', 'Formato no reconocido.', 'Usá Cookie Editor JSON, JSON envuelto, Header String o Netscape.')
  }

  const nowSeconds = Math.trunc(nowMs / 1000)
  const normalized = new Map<string, NormalizedCookie>()
  for (const item of items) {
    const cookie = normalizeItem(item)
    if (cookie.expires !== null && cookie.expires <= nowSeconds) continue
    normalized.set(`${cookie.domain.toLowerCase()}\u0000${cookie.path}\u0000${cookie.name}`, cookie)
  }
  const cookies = [...normalized.values()]
  if (!cookies.length) throw new SessionInputError('NO_VALID_COOKIES', 'No quedaron cookies válidas después de normalizar.', 'Renová la sesión y exportala nuevamente.')
  const names = new Set(cookies.map((cookie) => cookie.name))
  const criticalPresent = CRITICAL_COOKIE_NAMES.filter((name) => names.has(name))
  const criticalMissing = CRITICAL_COOKIE_NAMES.filter((name) => !names.has(name))
  return { formatDetected, cookies, criticalPresent, criticalMissing }
}

function cookieHeader(cookies: NormalizedCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

async function readBoundedText(response: Response, maxBytes = MAX_GOOGLE_RESPONSE_BYTES): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel('response too large')
        throw new Error('GOOGLE_RESPONSE_TOO_LARGE')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

function publicStatus(
  state: SessionPublicStatus['state'],
  health: SessionPublicStatus['health'],
  configured: boolean,
  message: string,
  parsed: ParsedSession | null,
): SessionPublicStatus {
  return {
    appAuthenticated: true,
    state,
    health,
    configured,
    formatDetected: parsed?.formatDetected ?? null,
    count: parsed?.cookies.length ?? 0,
    criticalPresent: parsed?.criticalPresent ?? [],
    criticalMissing: parsed?.criticalMissing ?? [...CRITICAL_COOKIE_NAMES],
    message,
  }
}

export function parseLocationSharingResponse(body: string, receivedAt = new Date().toISOString()): SharedPoint | null {
  const text = body.replace(/^\)\]\}'\s*\n?/, '')
  const flat = text.match(/\[null,(-?\d+\.\d+),(-?\d+\.\d+)\]/)
  const nested = flat ? null : text.match(/\[null,\[(-?\d+\.\d+),(-?\d+\.\d+)\]\]/)
  const match = flat ?? nested
  if (!match) return null
  const lng = Number(match[1])
  const lat = Number(match[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null

  const batteryMatch = text.match(/\[0,(\d{1,3})\],3,null,\[1\]/)
  const accuracyMatch = text.match(/\]\s*,\s*\d{13}\s*,\s*(\d+)\s*,\s*"/)
  const chargingMatch = text.match(/\[0,\d{1,3}\]\s*,\s*(\d)\s*,/)
  const timestampCandidates = [...text.matchAll(/\b(\d{13})\b/g)]
    .map((candidate) => Number(candidate[1]))
    .filter((value) => Number.isFinite(value) && value > 0)
  const timestamp = timestampCandidates.length ? new Date(Math.max(...timestampCandidates)).toISOString() : receivedAt
  const batteryValue = batteryMatch ? Number(batteryMatch[1]) : null

  return {
    lat,
    lng,
    timestamp,
    accuracy: accuracyMatch ? Number(accuracyMatch[1]) : null,
    battery: batteryValue !== null && batteryValue >= 0 && batteryValue <= 100 ? batteryValue : null,
    charging: chargingMatch ? chargingMatch[1] === '1' : null,
  }
}

export async function probeGoogleMapsSession(
  parsed: ParsedSession,
  fetchImpl: typeof fetch = fetch,
  receivedAt = new Date().toISOString(),
): Promise<ProbeResult> {
  if (parsed.criticalMissing.length) {
    return { status: publicStatus('SHARED_UNCONFIGURED', 'INCOMPLETE', false, 'La sesión está incompleta.', parsed), point: null }
  }

  let response: Response
  try {
    response = await fetchImpl(LOCATION_SHARING_URL, {
      method: 'GET',
      headers: {
        Cookie: cookieHeader(parsed.cookies),
        'User-Agent': 'Mozilla/5.0 STRACKER-zero-cost-runtime-poc',
        Accept: 'application/json,text/plain,*/*',
        'Cache-Control': 'no-cache',
        Referer: 'https://www.google.com/maps',
        'X-Goog-AuthUser': '0',
      },
      redirect: 'error',
    })
  } catch {
    return { status: publicStatus('SHARED_ERROR', 'UPSTREAM_UNAVAILABLE', false, 'Google no responde temporalmente.', parsed), point: null }
  }

  if (response.status === 401 || response.status === 403) {
    return { status: publicStatus('SHARED_EXPIRED', 'EXPIRED', false, 'La sesión venció o fue revocada.', parsed), point: null }
  }
  if (response.status >= 500) {
    return { status: publicStatus('SHARED_ERROR', 'UPSTREAM_UNAVAILABLE', false, 'Google no responde temporalmente.', parsed), point: null }
  }
  if (response.status !== 200) {
    return { status: publicStatus('SHARED_PERMISSION_REVOKED', 'INVALID', false, 'Google rechazó la sesión.', parsed), point: null }
  }

  let body: string
  try {
    body = await readBoundedText(response)
  } catch {
    return { status: publicStatus('SHARED_ERROR', 'UNSUPPORTED_RESPONSE', false, 'Google devolvió una respuesta no procesable.', parsed), point: null }
  }
  const point = parseLocationSharingResponse(body, receivedAt)
  if (point) return { status: publicStatus('SHARED_READY', 'VALID', true, 'Sesión válida — ubicación disponible.', parsed), point }
  const lower = body.toLowerCase()
  if (lower.includes('locationsharing') || lower.includes('location sharing') || body.startsWith(")]}'")) {
    return { status: publicStatus('SHARED_NO_LOCATION', 'NO_LOCATION_SHARED', true, 'Sesión válida — sin ubicación activa.', parsed), point: null }
  }
  return { status: publicStatus('SHARED_ERROR', 'UNSUPPORTED_RESPONSE', false, 'Google devolvió un formato no reconocido.', parsed), point: null }
}

export function unconfiguredStatus(): SessionPublicStatus {
  return publicStatus('SHARED_UNCONFIGURED', 'UNCONFIGURED', false, 'No hay una sesión vinculada.', null)
}
