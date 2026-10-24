import type { CookieHistoryResponse, CookieHistorySegment } from './cookie-session-durable.js'

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving/'
const MAX_ROAD_GAPS_PER_HISTORY = 4
const MAX_ROUTE_DISTANCE_M = 35_000
const ROUTE_TIMEOUT_MS = 3_500
const CACHE_SUCCESS_MS = 10 * 60 * 1000
const CACHE_FAILURE_MS = 60 * 1000

type RouteCacheEntry = { expiresAt: number; points: Array<{ lat: number; lng: number }> | null; confidence: 'high' | 'medium' }
const routeCache = new Map<string, RouteCacheEntry>()

function haversineMeters(left: { lat: number; lng: number }, right: { lat: number; lng: number }): number {
  const radians = (degrees: number) => degrees * Math.PI / 180
  const earth = 6_371_000
  const lat1 = radians(left.lat)
  const lat2 = radians(right.lat)
  const dLat = lat2 - lat1
  const dLng = radians(right.lng - left.lng)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return earth * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)))
}

function validCoordinate(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])
    && value[0] >= -180 && value[0] <= 180 && value[1] >= -90 && value[1] <= 90
}

function cacheKey(segment: CookieHistorySegment): string {
  const first = segment.points[0]
  const last = segment.points[segment.points.length - 1]
  return `${first?.lat.toFixed(5)},${first?.lng.toFixed(5)}|${last?.lat.toFixed(5)},${last?.lng.toFixed(5)}|${Math.round((Date.parse(segment.endedAt) - Date.parse(segment.startedAt)) / 60_000)}`
}

async function roadRoute(segment: CookieHistorySegment): Promise<RouteCacheEntry> {
  const key = cacheKey(segment)
  const cached = routeCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached
  const first = segment.points[0]
  const last = segment.points[segment.points.length - 1]
  const failed = (): RouteCacheEntry => ({ expiresAt: Date.now() + CACHE_FAILURE_MS, points: null, confidence: 'medium' })
  if (!first || !last || haversineMeters(first, last) > MAX_ROUTE_DISTANCE_M) return failed()
  const elapsedSeconds = Math.max(1, (Date.parse(segment.endedAt) - Date.parse(segment.startedAt)) / 1000)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort('ROAD_ROUTE_TIMEOUT'), ROUTE_TIMEOUT_MS)
  try {
    const coordinates = `${first.lng},${first.lat};${last.lng},${last.lat}`
    const url = `${OSRM_BASE}${coordinates}?alternatives=true&steps=false&overview=full&geometries=geojson`
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'STRACKER/ORDER-001 road-gap inference' } })
    if (!response.ok) { const entry = failed(); routeCache.set(key, entry); return entry }
    const payload = await response.json().catch(() => null) as { code?: string; routes?: Array<{ distance?: number; duration?: number; geometry?: { type?: string; coordinates?: unknown[] } }> } | null
    if (payload?.code !== 'Ok' || !Array.isArray(payload.routes)) { const entry = failed(); routeCache.set(key, entry); return entry }
    const straightDistance = Math.max(1, haversineMeters(first, last))
    const candidates = payload.routes.flatMap((route) => {
      const coords = route.geometry?.type === 'LineString' && Array.isArray(route.geometry.coordinates) ? route.geometry.coordinates : null
      if (!coords || coords.length < 2 || coords.length > 20_000) return []
      const points = coords.filter(validCoordinate).map(([lng, lat]) => ({ lat, lng }))
      if (points.length < 2) return []
      const distance = Number(route.distance)
      const duration = Number(route.duration)
      if (!Number.isFinite(distance) || !Number.isFinite(duration) || distance <= 0 || duration <= 0) return []
      const averageSpeed = distance / elapsedSeconds
      if (averageSpeed > 55 || distance > Math.max(straightDistance * 7, MAX_ROUTE_DISTANCE_M * 1.5)) return []
      const timeFit = Math.max(0, 1 - Math.abs(duration - elapsedSeconds) / Math.max(elapsedSeconds, 300))
      const distanceFit = Math.max(0, 1 - Math.max(0, distance / straightDistance - 3) / 4)
      const priorBoost = segment.confidence === 'high' ? 0.12 : segment.confidence === 'medium' ? 0.06 : 0
      const score = timeFit * 0.58 + distanceFit * 0.3 + priorBoost
      return [{ points, score }]
    }).sort((left, right) => right.score - left.score)
    if (!candidates.length) { const entry = failed(); routeCache.set(key, entry); return entry }
    const best = candidates[0]
    const entry: RouteCacheEntry = { expiresAt: Date.now() + CACHE_SUCCESS_MS, points: best.points, confidence: best.score >= 0.78 ? 'high' : 'medium' }
    routeCache.set(key, entry)
    return entry
  } catch {
    const entry = failed(); routeCache.set(key, entry); return entry
  } finally {
    clearTimeout(timeout)
  }
}

function addPreObservationInference(history: CookieHistoryResponse): CookieHistorySegment[] {
  const first = history.points[0]
  if (!first || Date.parse(first.capturedAt) <= Date.parse(history.windowStart)) return history.segments
  const inferred: CookieHistorySegment = {
    id: 'inferred-pre-observation-window',
    provenance: 'inferred',
    confidence: 'low',
    method: 'generic-plausible-fallback',
    startedAt: history.windowStart,
    endedAt: first.capturedAt,
    points: [{ lat: first.lat, lng: first.lng }],
  }
  return [inferred, ...history.segments]
}

export async function enrichCookieHistoryWithRoadNetwork(history: CookieHistoryResponse): Promise<CookieHistoryResponse> {
  const initial = addPreObservationInference(history)
  const candidateIndexes = initial.map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment.provenance === 'inferred' && segment.points.length >= 2)
    .slice(0, MAX_ROAD_GAPS_PER_HISTORY)
  const resolved = await Promise.all(candidateIndexes.map(async ({ segment, index }) => ({ index, route: await roadRoute(segment) })))
  const replacements = new Map(resolved.map(({ index, route }) => [index, route]))
  const segments = initial.map((segment, index) => {
    const route = replacements.get(index)
    if (!route?.points) return segment
    return { ...segment, points: route.points, confidence: route.confidence, method: 'road-network-route' as CookieHistorySegment['method'] }
  })
  return { ...history, segments }
}
