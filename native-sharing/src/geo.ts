import type { AcceptedNativePoint, NativeSharedLocationPoint, NativeSharingSession } from './contracts.js'
import {
  MAX_ACCURACY_M,
  MAX_FUTURE_SKEW_MS,
  MAX_IMPOSSIBLE_SPEED_MPS,
  MAX_POINT_AGE_MS,
  MAX_POINTS_PER_SESSION,
  MAX_SPEED_MPS,
  MIN_POINT_INTERVAL_MS,
} from './limits.js'

export class PointValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PointValidationError'
  }
}

function optionalFinite(value: number | null, min: number, max: number, code: string): number | null {
  if (value === null) return null
  if (!Number.isFinite(value) || value < min || value > max) throw new PointValidationError(code, 'Point field is outside accepted bounds.')
  return value
}

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const radians = (degrees: number) => degrees * Math.PI / 180
  const radius = 6_371_000
  const dLat = radians(b.lat - a.lat)
  const dLng = radians(b.lng - a.lng)
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2
  return radius * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

export function validateNativePoint(
  input: NativeSharedLocationPoint,
  session: NativeSharingSession,
  previous: AcceptedNativePoint | null,
  nowMs: number,
): NativeSharedLocationPoint {
  if (!input || input.version !== 1) throw new PointValidationError('VERSION_REJECTED', 'Unsupported point version.')
  if (!Number.isSafeInteger(input.sequence) || input.sequence <= 0) throw new PointValidationError('SEQUENCE_INVALID', 'Sequence must be a positive integer.')
  if (input.sequence <= session.lastSequence) throw new PointValidationError('REPLAY_REJECTED', 'Sequence was already accepted or rolled back.')
  if (session.pointCount >= MAX_POINTS_PER_SESSION) throw new PointValidationError('RETENTION_LIMIT', 'Session point limit reached.')
  if (!Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90) throw new PointValidationError('LATITUDE_INVALID', 'Latitude is invalid.')
  if (!Number.isFinite(input.lng) || input.lng < -180 || input.lng > 180) throw new PointValidationError('LONGITUDE_INVALID', 'Longitude is invalid.')
  optionalFinite(input.accuracyM, 0, MAX_ACCURACY_M, 'ACCURACY_INVALID')
  optionalFinite(input.speedMps, 0, MAX_SPEED_MPS, 'SPEED_INVALID')
  optionalFinite(input.headingDeg, 0, 359.999999, 'HEADING_INVALID')

  const capturedMs = Date.parse(input.capturedAt)
  if (!Number.isFinite(capturedMs)) throw new PointValidationError('TIMESTAMP_INVALID', 'capturedAt is invalid.')
  if (capturedMs > nowMs + MAX_FUTURE_SKEW_MS) throw new PointValidationError('TIMESTAMP_FUTURE', 'Point timestamp is too far in the future.')
  if (capturedMs < nowMs - MAX_POINT_AGE_MS) throw new PointValidationError('TIMESTAMP_TOO_OLD', 'Point is too old.')

  if (previous) {
    const previousMs = Date.parse(previous.capturedAt)
    const deltaMs = capturedMs - previousMs
    if (deltaMs <= 0) throw new PointValidationError('TIMESTAMP_REPLAY', 'Point timestamp did not advance.')
    if (deltaMs < MIN_POINT_INTERVAL_MS) throw new PointValidationError('FREQUENCY_LIMIT', 'Points are arriving too frequently.')
    const distance = haversineMeters(previous, input)
    const speedMps = distance / (deltaMs / 1000)
    if (speedMps > MAX_IMPOSSIBLE_SPEED_MPS) throw new PointValidationError('IMPOSSIBLE_JUMP', 'Point implies an impossible jump.')
  }

  return input
}
