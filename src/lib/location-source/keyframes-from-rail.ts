import type { GhostRailSegment, LocationKeyframe } from './contracts'

const SIGNIFICANT_DISPLACEMENT_M = 250
const MAJOR_DIRECTION_CHANGE_DEG = 60

interface TimedPoint {
  lat: number
  lng: number
  at: string
  observedAt: boolean
}

function distanceMeters(a: TimedPoint, b: TimedPoint): number {
  const r = 6_371_000
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const lat1 = a.lat * rad
  const lat2 = b.lat * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return r * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function bearingDeg(a: TimedPoint, b: TimedPoint): number | null {
  if (a.lat === b.lat && a.lng === b.lng) return null
  const rad = Math.PI / 180
  const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad)
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad)
    - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad)
  return (Math.atan2(y, x) / rad + 360) % 360
}

function angleDelta(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360
  return raw > 180 ? 360 - raw : raw
}

function segmentPoints(segment: GhostRailSegment): TimedPoint[] {
  const start = Date.parse(segment.startedAt)
  const end = Date.parse(segment.endedAt)
  const validBounds = Number.isFinite(start) && Number.isFinite(end) && end >= start
  const count = segment.points.length
  return segment.points.map((point, index) => {
    const ratio = count <= 1 ? 0 : index / (count - 1)
    const atMs = validBounds ? start + (end - start) * ratio : Date.now()
    return {
      lat: point.lat,
      lng: point.lng,
      at: new Date(atMs).toISOString(),
      observedAt: index === 0 || index === count - 1,
    }
  })
}

/**
 * Builds the 24-hour event timeline from GhostRail.
 *
 * GhostRail stores exact observed timestamps at segment boundaries, but not for
 * every point inside a segment. Boundary events remain observed; any event whose
 * timestamp is reconstructed by interpolation is explicitly marked inferred.
 */
export function keyframesFromGhostrail(segments: GhostRailSegment[]): LocationKeyframe[] {
  const ordered = [...segments]
    .filter((segment) => segment.points.length > 0)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))

  if (!ordered.length) return []

  const frames: LocationKeyframe[] = []
  let previousEnd: TimedPoint | null = null
  let previousBearing: number | null = null
  let id = 0
  const push = (type: LocationKeyframe['type'], point: TimedPoint, observed = point.observedAt) => {
    frames.push({
      id: `${type}-${id++}`,
      type,
      at: point.at,
      lat: point.lat,
      lng: point.lng,
      provenance: observed ? 'observed' : 'inferred',
      confidence: observed ? 'high' : 'medium',
    })
  }

  for (const segment of ordered) {
    const points = segmentPoints(segment)
    const first = points[0]
    if (!previousEnd) {
      push('session_observation_start', first, true)
    } else if (Date.parse(first.at) > Date.parse(previousEnd.at)) {
      push('data_gap_start', previousEnd, true)
      push('data_gap_recovered', first, true)
    }

    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1]
      const current = points[index]
      const displacement = distanceMeters(previous, current)
      if (displacement >= SIGNIFICANT_DISPLACEMENT_M) push('significant_displacement', current)

      const bearing = bearingDeg(previous, current)
      if (bearing !== null && previousBearing !== null && angleDelta(previousBearing, bearing) >= MAJOR_DIRECTION_CHANGE_DEG) {
        push('major_direction_change', current)
      }
      if (bearing !== null) previousBearing = bearing
    }

    previousEnd = points.at(-1) ?? previousEnd
  }

  return frames
}
