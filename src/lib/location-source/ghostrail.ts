import type { FreshnessState, GhostRailSegment, LocationSample, LocationSource } from './contracts'
import type { AccuracyFilterResult } from './accuracy-filter'

export interface GhostRailState {
  source: LocationSource
  sessionEpoch: number
  segments: GhostRailSegment[]
}

export interface GhostRailInput {
  sample: LocationSample
  filter: AccuracyFilterResult
  freshness: FreshnessState
  sessionEpoch: number
  sessionReplaced?: boolean
}

export function initialGhostRailState(source: LocationSource, sessionEpoch = 0): GhostRailState {
  return { source, sessionEpoch, segments: [] }
}

function maximumIntervalMs(source: LocationSource): number {
  return source === 'my-device' ? 45_000 : 180_000
}

function segmentId(source: LocationSource, epoch: number, capturedAt: string, index: number): string {
  return `${source}:${epoch}:${capturedAt}:${index}`
}

export function updateGhostRail(previous: GhostRailState, input: GhostRailInput): GhostRailState {
  const { sample, filter, freshness, sessionEpoch } = input
  if (sample.source !== previous.source || sessionEpoch !== previous.sessionEpoch || input.sessionReplaced) {
    previous = initialGhostRailState(sample.source, sessionEpoch)
  }

  if (filter.decision !== 'accepted' || !filter.visualPoint || freshness === 'stale' || freshness === 'expired') {
    return previous
  }

  const lastSegment = previous.segments.at(-1)
  const lastCapturedAt = lastSegment?.endedAt ?? null
  const intervalMs = lastCapturedAt ? Date.parse(sample.capturedAt) - Date.parse(lastCapturedAt) : null
  const discontinuity =
    !lastSegment ||
    intervalMs === null ||
    intervalMs <= 0 ||
    intervalMs > maximumIntervalMs(sample.source) ||
    filter.reason === 'first-point'

  if (discontinuity) {
    const nextSegment: GhostRailSegment = {
      id: segmentId(sample.source, sessionEpoch, sample.capturedAt, previous.segments.length),
      source: sample.source,
      sessionEpoch,
      points: [filter.visualPoint],
      startedAt: sample.capturedAt,
      endedAt: sample.capturedAt,
    }
    return { ...previous, segments: [...previous.segments, nextSegment] }
  }

  const nextSegment: GhostRailSegment = {
    ...lastSegment,
    points: [...lastSegment.points, filter.visualPoint],
    endedAt: sample.capturedAt,
  }
  return {
    ...previous,
    segments: [...previous.segments.slice(0, -1), nextSegment],
  }
}

export function trimGhostRail(state: GhostRailState, maximumPoints = 600): GhostRailState {
  let remaining = maximumPoints
  const kept: GhostRailSegment[] = []
  for (const segment of [...state.segments].reverse()) {
    if (remaining <= 0) break
    const points = segment.points.slice(Math.max(0, segment.points.length - remaining))
    if (points.length) kept.push({ ...segment, points })
    remaining -= points.length
  }
  return { ...state, segments: kept.reverse() }
}
