import { describe, expect, test } from 'bun:test'
import { filterLocationSample, initialAccuracyFilterState } from '../../src/lib/location-source/accuracy-filter'
import type { LocationSample } from '../../src/lib/location-source/contracts'

function sample(overrides: Partial<LocationSample> = {}): LocationSample {
  return {
    source: 'my-device',
    lat: -31.6333,
    lng: -60.7,
    accuracyM: 12,
    capturedAt: '2026-07-21T12:00:00.000Z',
    receivedAt: '2026-07-21T12:00:00.100Z',
    speedMps: null,
    headingDeg: null,
    ...overrides,
  }
}

describe('accuracy filter', () => {
  test('accepts the first valid point', () => {
    const result = filterLocationSample(initialAccuracyFilterState(), sample())
    expect(result.decision).toBe('accepted')
    expect(result.reason).toBe('first-point')
  })

  test('updates metadata without moving the visual coordinate inside accuracy zone', () => {
    const first = filterLocationSample(initialAccuracyFilterState(), sample())
    const noisy = filterLocationSample(first.state, sample({
      lat: -31.63331,
      lng: -60.70001,
      accuracyM: 18,
      capturedAt: '2026-07-21T12:00:05.000Z',
      receivedAt: '2026-07-21T12:00:05.050Z',
    }))
    expect(noisy.decision).toBe('metadata-only')
    expect(noisy.visualPoint).toEqual(first.visualPoint)
    expect(noisy.state.lastObservedSample?.accuracyM).toBe(18)
  })

  test('rejects an impossible jump', () => {
    const first = filterLocationSample(initialAccuracyFilterState(), sample())
    const jump = filterLocationSample(first.state, sample({
      lat: -34.6037,
      lng: -58.3816,
      capturedAt: '2026-07-21T12:00:10.000Z',
    }))
    expect(jump.decision).toBe('rejected')
    expect(jump.reason).toBe('impossible-speed')
    expect(jump.visualPoint).toEqual(first.visualPoint)
  })

  test('rejects unusable device accuracy', () => {
    const result = filterLocationSample(initialAccuracyFilterState(), sample({ accuracyM: 500 }))
    expect(result.decision).toBe('rejected')
    expect(result.reason).toBe('insufficient-accuracy')
  })

  test('does not accept duplicate or out-of-order timestamps', () => {
    const first = filterLocationSample(initialAccuracyFilterState(), sample())
    const duplicate = filterLocationSample(first.state, sample({ lat: -31.64 }))
    expect(duplicate.reason).toBe('duplicate-or-out-of-order')
  })
})
