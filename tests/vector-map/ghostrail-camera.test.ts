import { describe, expect, test } from 'bun:test'
import { initialGhostRailState, updateGhostRail } from '../../src/lib/location-source/ghostrail'
import { initialCameraControllerState, planCamera } from '../../src/lib/location-source/camera-controller'
import type { AccuracyFilterResult } from '../../src/lib/location-source/accuracy-filter'
import type { LocationSample } from '../../src/lib/location-source/contracts'

function sample(capturedAt: string, lat: number, lng: number): LocationSample {
  return {
    source: 'my-device', lat, lng, accuracyM: 5, capturedAt,
    receivedAt: capturedAt, speedMps: 2, headingDeg: 90,
  }
}

function accepted(point: { lat: number; lng: number }): AccuracyFilterResult {
  return {
    decision: 'accepted', reason: 'visual-movement', visualPoint: point,
    distanceM: 10, elapsedS: 5, derivedSpeedMps: 2,
    state: { stablePoint: point, lastAcceptedSample: null, lastObservedSample: null },
  }
}

describe('GhostRail segmentation', () => {
  test('does not connect excessive time gaps', () => {
    let state = initialGhostRailState('my-device')
    state = updateGhostRail(state, { sample: sample('2026-07-21T12:00:00Z', -31.63, -60.70), filter: accepted({ lat: -31.63, lng: -60.70 }), freshness: 'fresh', sessionEpoch: 0 })
    state = updateGhostRail(state, { sample: sample('2026-07-21T12:00:10Z', -31.631, -60.701), filter: accepted({ lat: -31.631, lng: -60.701 }), freshness: 'fresh', sessionEpoch: 0 })
    state = updateGhostRail(state, { sample: sample('2026-07-21T12:02:00Z', -31.632, -60.702), filter: accepted({ lat: -31.632, lng: -60.702 }), freshness: 'fresh', sessionEpoch: 0 })
    expect(state.segments).toHaveLength(2)
    expect(state.segments[0].points).toHaveLength(2)
    expect(state.segments[1].points).toHaveLength(1)
  })

  test('rejected or stale points are not rendered', () => {
    let state = initialGhostRailState('my-device')
    const point = sample('2026-07-21T12:00:00Z', -31.63, -60.70)
    state = updateGhostRail(state, { sample: point, filter: { ...accepted(point), decision: 'rejected', reason: 'impossible-speed' }, freshness: 'fresh', sessionEpoch: 0 })
    state = updateGhostRail(state, { sample: point, filter: accepted(point), freshness: 'stale', sessionEpoch: 0 })
    expect(state.segments).toHaveLength(0)
  })

  test('session replacement clears all segments', () => {
    let state = initialGhostRailState('google-shared', 1)
    const remote = { ...sample('2026-07-21T12:00:00Z', -31.63, -60.70), source: 'google-shared' as const }
    state = updateGhostRail(state, { sample: remote, filter: accepted(remote), freshness: 'fresh', sessionEpoch: 1 })
    state = updateGhostRail(state, { sample: remote, filter: accepted(remote), freshness: 'fresh', sessionEpoch: 2, sessionReplaced: true })
    expect(state.sessionEpoch).toBe(2)
    expect(state.segments).toHaveLength(1)
  })
})

describe('camera controller', () => {
  test('manual mode suppresses automatic movement', () => {
    const manual = planCamera({ current: initialCameraControllerState(), motion: 'moving', hasPoint: true, userInteracted: true })
    expect(manual.state.mode).toBe('manual')
    expect(manual.shouldMove).toBe(false)
    const update = planCamera({ current: manual.state, motion: 'moving', hasPoint: true, measuredBearingDeg: 120 })
    expect(update.state.mode).toBe('manual')
    expect(update.shouldMove).toBe(false)
  })

  test('recenter exits manual into the correct automatic mode', () => {
    const result = planCamera({ current: { mode: 'manual', bearingDeg: 10 }, motion: 'stationary', hasPoint: true, recenter: true })
    expect(result.state.mode).toBe('stationary')
    expect(result.shouldMove).toBe(true)
  })

  test('reduced motion removes animated camera duration', () => {
    const result = planCamera({ current: initialCameraControllerState(), motion: 'moving', hasPoint: true, recenter: true, reducedMotion: true })
    expect(result.state.mode).toBe('follow')
    expect(result.animate).toBe(false)
    expect(result.durationMs).toBe(0)
    expect(result.pitchDeg).toBeLessThanOrEqual(40)
  })
})
