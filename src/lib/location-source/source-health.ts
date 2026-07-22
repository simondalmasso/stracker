import type { LocationSource, SourceHealth } from './contracts'

export interface SourceHealthInput {
  source: LocationSource
  lastReceivedAt: string | null
  consecutiveErrors: number
  nowMs?: number
}

export function sourceHealthFromInput({
  source,
  lastReceivedAt,
  consecutiveErrors,
  nowMs = Date.now(),
}: SourceHealthInput): SourceHealth {
  if (!lastReceivedAt) return consecutiveErrors > 0 ? 'unreachable' : 'unknown'
  const receivedMs = Date.parse(lastReceivedAt)
  if (!Number.isFinite(receivedMs)) return 'unknown'
  const ageMs = Math.max(0, nowMs - receivedMs)
  const degradedAfterMs = source === 'my-device' ? 45_000 : 75_000
  const unreachableAfterMs = source === 'my-device' ? 150_000 : 180_000
  if (consecutiveErrors >= 3 || ageMs > unreachableAfterMs) return 'unreachable'
  if (consecutiveErrors > 0 || ageMs > degradedAfterMs) return 'degraded'
  return 'receiving'
}
