import type { LocationSample, LocationSource, MotionState } from './contracts'
import type { AccuracyFilterResult } from './accuracy-filter'

export interface MotionClassifierState {
  motion: MotionState
  movingConfirmations: number
  stationaryConfirmations: number
}

export interface MotionClassifierResult {
  state: MotionClassifierState
  evidence: 'moving' | 'stationary' | 'insufficient' | 'rejected'
}

export function initialMotionClassifierState(): MotionClassifierState {
  return { motion: 'unknown', movingConfirmations: 0, stationaryConfirmations: 0 }
}

function thresholds(source: LocationSource): { moving: number; stationary: number; movingConfirmations: number; stationaryConfirmations: number } {
  return source === 'my-device'
    ? { moving: 1.1, stationary: 0.45, movingConfirmations: 2, stationaryConfirmations: 3 }
    : { moving: 1.4, stationary: 0.25, movingConfirmations: 2, stationaryConfirmations: 2 }
}

function plausibleReportedSpeed(sample: LocationSample): number | null {
  if (sample.speedMps === null || !Number.isFinite(sample.speedMps) || sample.speedMps < 0 || sample.speedMps > 90) return null
  return sample.speedMps
}

export function classifyMotion(
  previous: MotionClassifierState,
  sample: LocationSample,
  filter: AccuracyFilterResult,
): MotionClassifierResult {
  if (filter.decision === 'rejected') {
    return { state: previous, evidence: 'rejected' }
  }

  const sourceThresholds = thresholds(sample.source)
  const reported = plausibleReportedSpeed(sample)
  const derived = filter.derivedSpeedMps
  const speed = reported ?? derived
  const remoteTimingUsable = sample.source === 'my-device' || (filter.elapsedS !== null && filter.elapsedS >= 5 && filter.elapsedS <= 180)

  let evidence: MotionClassifierResult['evidence'] = 'insufficient'
  if (remoteTimingUsable && speed !== null && speed >= sourceThresholds.moving && filter.decision === 'accepted') {
    evidence = 'moving'
  } else if (
    remoteTimingUsable &&
    filter.decision === 'metadata-only' &&
    (speed === null || speed <= sourceThresholds.stationary)
  ) {
    evidence = 'stationary'
  }

  if (evidence === 'moving') {
    const movingConfirmations = previous.movingConfirmations + 1
    return {
      evidence,
      state: {
        motion: movingConfirmations >= sourceThresholds.movingConfirmations ? 'moving' : previous.motion,
        movingConfirmations,
        stationaryConfirmations: 0,
      },
    }
  }

  if (evidence === 'stationary') {
    const stationaryConfirmations = previous.stationaryConfirmations + 1
    return {
      evidence,
      state: {
        motion: stationaryConfirmations >= sourceThresholds.stationaryConfirmations ? 'stationary' : previous.motion,
        movingConfirmations: 0,
        stationaryConfirmations,
      },
    }
  }

  return {
    evidence,
    state: {
      motion: sample.source === 'google-shared' ? 'unknown' : previous.motion,
      movingConfirmations: 0,
      stationaryConfirmations: 0,
    },
  }
}
