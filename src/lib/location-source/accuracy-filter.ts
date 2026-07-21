import type { GeoPoint, LocationSample, LocationSource } from './contracts'
import { elapsedSeconds, haversineMeters, validCoordinate } from './geo'

export interface AccuracyFilterState {
  stablePoint: GeoPoint | null
  lastAcceptedSample: LocationSample | null
  lastObservedSample: LocationSample | null
}

export interface AccuracyFilterResult {
  decision: 'accepted' | 'metadata-only' | 'rejected'
  reason:
    | 'first-point'
    | 'visual-movement'
    | 'inside-accuracy-zone'
    | 'duplicate-or-out-of-order'
    | 'invalid-coordinate'
    | 'impossible-speed'
    | 'insufficient-accuracy'
  visualPoint: GeoPoint | null
  distanceM: number | null
  elapsedS: number | null
  derivedSpeedMps: number | null
  state: AccuracyFilterState
}

export interface AccuracyFilterConfig {
  minimumDeadZoneM: number
  maximumAccuracyM: number
  maximumPlausibleSpeedMps: number
}

const CONFIG: Record<LocationSource, AccuracyFilterConfig> = {
  'my-device': {
    minimumDeadZoneM: 4,
    maximumAccuracyM: 250,
    maximumPlausibleSpeedMps: 70,
  },
  'google-shared': {
    minimumDeadZoneM: 8,
    maximumAccuracyM: 5_000,
    maximumPlausibleSpeedMps: 90,
  },
}

export function initialAccuracyFilterState(): AccuracyFilterState {
  return { stablePoint: null, lastAcceptedSample: null, lastObservedSample: null }
}

export function filterLocationSample(
  previous: AccuracyFilterState,
  sample: LocationSample,
): AccuracyFilterResult {
  const config = CONFIG[sample.source]
  if (!validCoordinate(sample)) {
    return {
      decision: 'rejected', reason: 'invalid-coordinate', visualPoint: previous.stablePoint,
      distanceM: null, elapsedS: null, derivedSpeedMps: null,
      state: { ...previous, lastObservedSample: sample },
    }
  }

  if (sample.accuracyM !== null && sample.accuracyM > config.maximumAccuracyM) {
    return {
      decision: 'rejected', reason: 'insufficient-accuracy', visualPoint: previous.stablePoint,
      distanceM: previous.stablePoint ? haversineMeters(previous.stablePoint, sample) : null,
      elapsedS: previous.lastObservedSample ? elapsedSeconds(previous.lastObservedSample.capturedAt, sample.capturedAt) : null,
      derivedSpeedMps: null,
      state: { ...previous, lastObservedSample: sample },
    }
  }

  if (!previous.stablePoint || !previous.lastAcceptedSample) {
    const point = { lat: sample.lat, lng: sample.lng }
    return {
      decision: 'accepted', reason: 'first-point', visualPoint: point,
      distanceM: 0, elapsedS: null, derivedSpeedMps: sample.speedMps,
      state: { stablePoint: point, lastAcceptedSample: sample, lastObservedSample: sample },
    }
  }

  const elapsedS = elapsedSeconds(previous.lastAcceptedSample.capturedAt, sample.capturedAt)
  const distanceM = haversineMeters(previous.stablePoint, sample)
  if (elapsedS === null) {
    return {
      decision: 'rejected', reason: 'duplicate-or-out-of-order', visualPoint: previous.stablePoint,
      distanceM, elapsedS: null, derivedSpeedMps: null,
      state: { ...previous, lastObservedSample: sample },
    }
  }

  const derivedSpeedMps = distanceM / elapsedS
  const reportedSpeedMps = sample.speedMps !== null && sample.speedMps >= 0 ? sample.speedMps : null
  const speedForSafety = Math.max(derivedSpeedMps, reportedSpeedMps ?? 0)
  if (speedForSafety > config.maximumPlausibleSpeedMps) {
    return {
      decision: 'rejected', reason: 'impossible-speed', visualPoint: previous.stablePoint,
      distanceM, elapsedS, derivedSpeedMps,
      state: { ...previous, lastObservedSample: sample },
    }
  }

  const currentAccuracy = Math.max(0, sample.accuracyM ?? config.minimumDeadZoneM)
  const previousAccuracy = Math.max(0, previous.lastAcceptedSample.accuracyM ?? config.minimumDeadZoneM)
  const deadZoneM = Math.max(config.minimumDeadZoneM, currentAccuracy, previousAccuracy)
  if (distanceM <= deadZoneM) {
    return {
      decision: 'metadata-only', reason: 'inside-accuracy-zone', visualPoint: previous.stablePoint,
      distanceM, elapsedS, derivedSpeedMps,
      state: { ...previous, lastObservedSample: sample },
    }
  }

  const point = { lat: sample.lat, lng: sample.lng }
  return {
    decision: 'accepted', reason: 'visual-movement', visualPoint: point,
    distanceM, elapsedS, derivedSpeedMps,
    state: { stablePoint: point, lastAcceptedSample: sample, lastObservedSample: sample },
  }
}
