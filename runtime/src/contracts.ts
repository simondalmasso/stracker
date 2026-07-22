export type GoogleIdentityState = 'authenticated' | 'expired' | 'revoked'

export type SharedLinkState =
  | 'NO_VINCULADA'
  | 'VALIDANDO'
  | 'VINCULADA'
  | 'SESION_VENCIDA'
  | 'SESION_RECHAZADA'
  | 'GOOGLE_NO_DISPONIBLE'

export interface AccessIdentity {
  sub: string
  email?: string
  exp?: number
}

export interface NormalizedCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  expires: number | null
  httpOnly: boolean
  sameSite: string | null
}

export interface ParsedSession {
  formatDetected: string
  cookies: NormalizedCookie[]
  criticalPresent: string[]
  criticalMissing: string[]
}

export interface SessionPublicStatus {
  appAuthenticated: true
  state:
    | 'SHARED_UNCONFIGURED'
    | 'SHARED_VALIDATING'
    | 'SHARED_READY'
    | 'SHARED_NO_LOCATION'
    | 'SHARED_EXPIRED'
    | 'SHARED_PERMISSION_REVOKED'
    | 'SHARED_ERROR'
  health:
    | 'UNCONFIGURED'
    | 'VALID'
    | 'NO_LOCATION_SHARED'
    | 'EXPIRED'
    | 'INVALID'
    | 'INCOMPLETE'
    | 'UPSTREAM_UNAVAILABLE'
    | 'UNSUPPORTED_RESPONSE'
  configured: boolean
  formatDetected: string | null
  count: number
  criticalPresent: string[]
  criticalMissing: string[]
  message: string
}

export interface SharedPoint {
  lat: number
  lng: number
  timestamp: string
  accuracy: number | null
  battery: number | null
  charging: boolean | null
}

export interface ProbeResult {
  status: SessionPublicStatus
  point: SharedPoint | null
}

export interface StoredSessionRecord {
  subjectHash: string
  ivB64: string
  ciphertextB64: string
  createdAt: string
  updatedAt: string
}

export interface SessionStore {
  get(subjectHash: string): Promise<StoredSessionRecord | null>
  put(record: StoredSessionRecord): Promise<void>
  delete(subjectHash: string): Promise<void>
}
