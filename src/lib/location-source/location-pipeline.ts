import type {
  GhostRailSegment,
  LocationSample,
  LocationSessionState,
  LocationSnapshot,
  LocationSource,
} from './contracts'
import { freshnessFromTimestamp } from './contracts'
import {
  filterLocationSample,
  initialAccuracyFilterState,
  type AccuracyFilterState,
} from './accuracy-filter'
import {
  classifyMotion,
  initialMotionClassifierState,
  type MotionClassifierState,
} from './motion-classifier'
import {
  initialGhostRailState,
  trimGhostRail,
  updateGhostRail,
  type GhostRailState,
} from './ghostrail'
import { sourceHealthFromInput } from './source-health'

export interface LocationPipelineState {
  source: LocationSource
  sessionEpoch: number
  filter: AccuracyFilterState
  motion: MotionClassifierState
  rail: GhostRailState
  latest: LocationSnapshot | null
  consecutiveErrors: number
}

export interface LocationPipelineResult {
  state: LocationPipelineState
  snapshot: LocationSnapshot | null
  ghostrail: GhostRailSegment[]
}

export function initialLocationPipelineState(
  source: LocationSource,
  sessionEpoch = 0,
): LocationPipelineState {
  return {
    source,
    sessionEpoch,
    filter: initialAccuracyFilterState(),
    motion: initialMotionClassifierState(),
    rail: initialGhostRailState(source, sessionEpoch),
    latest: null,
    consecutiveErrors: 0,
  }
}

export function recordPipelineError(
  previous: LocationPipelineState,
  nowMs = Date.now(),
): LocationPipelineState {
  const consecutiveErrors = previous.consecutiveErrors + 1
  const latest = previous.latest
    ? {
        ...previous.latest,
        health: sourceHealthFromInput({
          source: previous.source,
          lastReceivedAt: previous.latest.receivedAt,
          consecutiveErrors,
          nowMs,
        }),
      }
    : null
  return { ...previous, consecutiveErrors, latest }
}

export function refreshPipelineTime(
  previous: LocationPipelineState,
  viewerSession: LocationSessionState,
  nowMs = Date.now(),
): LocationPipelineState {
  if (!previous.latest) return previous
  const latest = {
    ...previous.latest,
    freshness: freshnessFromTimestamp(previous.source, previous.latest.capturedAt, nowMs),
    health: sourceHealthFromInput({
      source: previous.source,
      lastReceivedAt: previous.latest.receivedAt,
      consecutiveErrors: previous.consecutiveErrors,
      nowMs,
    }),
    viewerSession,
  }
  return { ...previous, latest }
}

export function processLocationSample(
  previous: LocationPipelineState,
  sample: LocationSample,
  viewerSession: LocationSessionState,
): LocationPipelineResult {
  if (sample.source !== previous.source) {
    previous = initialLocationPipelineState(sample.source, previous.sessionEpoch + 1)
  }

  const filter = filterLocationSample(previous.filter, sample)
  const motion = classifyMotion(previous.motion, sample, filter)
  const freshness = freshnessFromTimestamp(sample.source, sample.capturedAt)
  const rail = trimGhostRail(updateGhostRail(previous.rail, {
    sample,
    filter,
    freshness,
    sessionEpoch: previous.sessionEpoch,
  }))

  const visual = filter.visualPoint
  const latest: LocationSnapshot | null = visual
    ? {
        ...sample,
        lat: visual.lat,
        lng: visual.lng,
        freshness,
        health: sourceHealthFromInput({ source: sample.source, lastReceivedAt: sample.receivedAt, consecutiveErrors: 0 }),
        motion: motion.state.motion,
        viewerSession,
        visualUpdated: filter.decision === 'accepted',
        filterDecision: filter.decision,
        filterReason: filter.reason,
      }
    : previous.latest
      ? {
          ...previous.latest,
          accuracyM: sample.accuracyM,
          capturedAt: sample.capturedAt,
          receivedAt: sample.receivedAt,
          speedMps: sample.speedMps,
          headingDeg: sample.headingDeg,
          freshness,
          health: sourceHealthFromInput({ source: sample.source, lastReceivedAt: sample.receivedAt, consecutiveErrors: 0 }),
          motion: motion.state.motion,
          viewerSession,
          visualUpdated: false,
          filterDecision: filter.decision,
          filterReason: filter.reason,
        }
      : null

  const state: LocationPipelineState = {
    ...previous,
    filter: filter.state,
    motion: motion.state,
    rail,
    latest,
    consecutiveErrors: 0,
  }
  return { state, snapshot: latest, ghostrail: rail.segments }
}

export function replacePipelineSession(
  previous: LocationPipelineState,
): LocationPipelineState {
  return initialLocationPipelineState(previous.source, previous.sessionEpoch + 1)
}
