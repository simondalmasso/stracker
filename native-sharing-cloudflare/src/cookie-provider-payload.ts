import type { CookiePoint, CookieSourceQuality } from './cookie-session.js'

const LOOKAROUND = 640
const FUTURE_SKEW_MS = 5 * 60 * 1000
const EARLIEST_MS = Date.UTC(2000, 0, 1)

function normalizedTimestamp(raw: string, nowMs: number): number | null {
  if (!/^\d{10,13}$/.test(raw)) return null
  const value = Number(raw)
  if (!Number.isFinite(value)) return null
  const milliseconds = raw.length <= 10 ? value * 1000 : value
  if (milliseconds < EARLIEST_MS || milliseconds > nowMs + FUTURE_SKEW_MS) return null
  return milliseconds
}

function nearestTimestamp(body: string, matchStart: number, matchEnd: number, nowMs: number): number | null {
  const start = Math.max(0, matchStart - LOOKAROUND)
  const end = Math.min(body.length, matchEnd + LOOKAROUND)
  const window = body.slice(start, end)
  const timestampPattern = /(?<!\d)(\d{10}|\d{13})(?!\d)/g
  let match: RegExpExecArray | null
  let best: { distance: number; value: number } | null = null
  const coordinateCenter = (matchStart + matchEnd) / 2
  while ((match = timestampPattern.exec(window))) {
    const value = normalizedTimestamp(match[1], nowMs)
    if (value === null) continue
    const absoluteCenter = start + match.index + match[1].length / 2
    const distance = Math.abs(absoluteCenter - coordinateCenter)
    if (!best || distance < best.distance) best = { distance, value }
  }
  return best?.value ?? null
}

export function extractProviderPoints(body: string, observedAt: string): CookiePoint[] {
  const observedMs = Date.parse(observedAt)
  const nowMs = Number.isFinite(observedMs) ? observedMs : Date.now()
  const patterns = [
    /\[null,(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)\]/g,
    /\[null,\[(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)\]\]/g,
  ]
  const collected = new Map<string, CookiePoint>()
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(body))) {
      const lng = Number(match[1])
      const lat = Number(match[2])
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) continue
      const timestamp = nearestTimestamp(body, match.index, match.index + match[0].length, nowMs)
      const capturedAt = timestamp === null ? new Date(nowMs).toISOString() : new Date(timestamp).toISOString()
      const sourceQuality: CookieSourceQuality = timestamp === null ? 'stracker_observed_at' : 'provider_timestamp'
      const point: CookiePoint = { lat, lng, accuracyM: null, capturedAt, observedAt: new Date(nowMs).toISOString(), sourceQuality }
      const key = `${lat.toFixed(7)}|${lng.toFixed(7)}|${capturedAt}`
      const existing = collected.get(key)
      if (!existing || (existing.sourceQuality !== 'provider_timestamp' && sourceQuality === 'provider_timestamp')) collected.set(key, point)
    }
  }
  return [...collected.values()].sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt))
}
