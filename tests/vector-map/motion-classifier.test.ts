import { describe, expect, test } from 'bun:test'
import { classifyMotion, initialMotionClassifierState } from '../../src/lib/location-source/motion-classifier'
import type { AccuracyFilterResult } from '../../src/lib/location-source/accuracy-filter'
import type { LocationSample } from '../../src/lib/location-source/contracts'

function sample(source: LocationSample['source'], speedMps: number | null): LocationSample {
  return {
    source,
    lat: -31.6333,
    lng: -60.7,
    accuracyM: 8,
    capturedAt: '2026-07-21T12:00:10.000Z',
    receivedAt: '2026-07-21T12:00:10.100Z',
    speedMps,
    headingDeg: 90,
  }
}

function filter(decision: AccuracyFilterResult['decision'], derivedSpeedMps: number | null, elapsedS = 10): AccuracyFilterResult {
  return {
    decision,
    reason: decision === 'accepted' ? 'visual-movement' : 'inside-accuracy-zone',
    visualPoint: { lat: -31.6333, lng: -60.7 },
    distanceM: derivedSpeedMps === null ? 0 : derivedSpeedMps * elapsedS,
    elapsedS,
    derivedSpeedMps,
    state: { stablePoint: { lat: -31.6333, lng: -60.7 }, lastAcceptedSample: null, lastObservedSample: null },
  }
}

describe('motion classifier', () => {
  test('requires confirmations before declaring movement', () => {
    const first = classifyMotion(initialMotionClassifierState(), sample('my-device', 2), filter('accepted', 2, 5))
    expect(first.state.motion).toBe('unknown')
    const second = classifyMotion(first.state, sample('my-device', 2), filter('accepted', 2, 5))
    expect(second.state.motion).toBe('moving')
  })

  test('uses stronger stationary hysteresis for device noise', () => {
    let state = initialMotionClassifierState()
    for (let index = 0; index < 2; index += 1) {
      state = classifyMotion(state, sample('my-device', 0), filter('metadata-only', 0, 5)).state
      expect(state.motion).toBe('unknown')
    }
    state = classifyMotion(state, sample('my-device', 0), filter('metadata-only', 0, 5)).state
    expect(state.motion).toBe('stationary')
  })

  test('keeps shared motion unknown when remote timing is not usable', () => {
    const result = classifyMotion(initialMotionClassifierState(), sample('shared-location', null), filter('accepted', 5, 1))
    expect(result.state.motion).toBe('unknown')
    expect(result.evidence).toBe('insufficient')
  })

  test('rejected points do not change motion', () => {
    const previous = { motion: 'moving' as const, movingConfirmations: 3, stationaryConfirmations: 0 }
    const result = classifyMotion(previous, sample('my-device', 40), { ...filter('accepted', 40), decision: 'rejected', reason: 'impossible-speed' })
    expect(result.state).toEqual(previous)
  })
})
