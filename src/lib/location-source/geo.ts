import type { Feature, Polygon } from 'geojson'
import type { GeoPoint } from './contracts'

const EARTH_RADIUS_M = 6_371_008.8

export function toRadians(value: number): number {
  return (value * Math.PI) / 180
}

export function toDegrees(value: number): number {
  return (value * 180) / Math.PI
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function normalizeBearing(value: number): number {
  return ((value % 360) + 360) % 360
}

export function shortestBearingDelta(from: number, to: number): number {
  return ((normalizeBearing(to) - normalizeBearing(from) + 540) % 360) - 180
}

export function smoothBearing(previous: number | null, next: number, alpha = 0.22): number {
  if (previous === null || !Number.isFinite(previous)) return normalizeBearing(next)
  return normalizeBearing(previous + shortestBearingDelta(previous, next) * clamp(alpha, 0, 1))
}

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)
  const deltaLat = lat2 - lat1
  const deltaLng = toRadians(b.lng - a.lng)
  const sinLat = Math.sin(deltaLat / 2)
  const sinLng = Math.sin(deltaLng / 2)
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
}

export function bearingDegrees(a: GeoPoint, b: GeoPoint): number {
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)
  const deltaLng = toRadians(b.lng - a.lng)
  const y = Math.sin(deltaLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng)
  return normalizeBearing(toDegrees(Math.atan2(y, x)))
}

export function validCoordinate(point: GeoPoint): boolean {
  return Number.isFinite(point.lat) && Number.isFinite(point.lng) && point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180
}

export function elapsedSeconds(previousIso: string, nextIso: string): number | null {
  const previous = Date.parse(previousIso)
  const next = Date.parse(nextIso)
  if (!Number.isFinite(previous) || !Number.isFinite(next) || next <= previous) return null
  return (next - previous) / 1000
}

export function circlePolygon(center: GeoPoint, radiusM: number, steps = 48): Feature<Polygon> {
  const safeRadius = Math.max(0, radiusM)
  const latRadians = toRadians(center.lat)
  const coordinates: [number, number][] = []
  for (let index = 0; index <= steps; index += 1) {
    const angle = (index / steps) * Math.PI * 2
    const north = Math.cos(angle) * safeRadius
    const east = Math.sin(angle) * safeRadius
    const deltaLat = north / 111_320
    const longitudeScale = Math.max(0.01, Math.cos(latRadians))
    const deltaLng = east / (111_320 * longitudeScale)
    coordinates.push([center.lng + deltaLng, center.lat + deltaLat])
  }
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [coordinates] },
  }
}
