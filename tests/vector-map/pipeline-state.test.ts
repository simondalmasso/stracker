import { describe, expect, test } from 'bun:test'
import { freshnessFromTimestamp } from '../../src/lib/location-source/contracts'
import { initialLocationPipelineState, processLocationSample, recordPipelineError, replacePipelineSession } from '../../src/lib/location-source/location-pipeline'
import { sourceHealthFromInput } from '../../src/lib/location-source/source-health'
import type { LocationSample } from '../../src/lib/location-source/contracts'

function sample(overrides: Partial<LocationSample> = {}): LocationSample {
  const now = Date.now()
  return {
    source: 'my-device',
    lat: -31.6333,
    lng: -60.7,
    accuracyM: 8,
    capturedAt: new Date(now).toISOString(),
    receivedAt: new Date(now).toISOString(),
    speedMps: null,
    headingDeg: null,
    ...overrides,
  }
}

describe('separate freshness and health state', () => {
  test('freshness depends on captured age, not transport health', () => {
    const now = Date.now()
    expect(freshnessFromTimestamp('shared-location', new Date(now - 120_000).toISOString(), now)).toBe('stale')
    expect(sourceHealthFromInput({ source: 'shared-location', lastReceivedAt: new Date(now).toISOString(), consecutiveErrors: 0, nowMs: now })).toBe('receiving')
  })

  test('health degrades independently after receive errors', () => {
    const first = processLocationSample(initialLocationPipelineState('my-device'), sample(), 'not-applicable').state
    const errored = recordPipelineError(recordPipelineError(first))
    expect(errored.latest?.freshness).toBe('fresh')
    expect(errored.latest?.health).toBe('degraded')
  })

  test('expired replaces the removed dead state', () => {
    const now = Date.now()
    expect(freshnessFromTimestamp('my-device', new Date(now - 180_000).toISOString(), now)).toBe('expired')
  })
})

describe('pipeline isolation', () => {
  test('source change resets stable point, movement and rail', () => {
    const initial = processLocationSample(initialLocationPipelineState('my-device'), sample(), 'not-applicable').state
    const remote = sample({
      source: 'shared-location',
      lat: -31.62,
      lng: -60.69,
      capturedAt: new Date(Date.now() + 10_000).toISOString(),
      receivedAt: new Date().toISOString(),
    })
    const changed = processLocationSample(initial, remote, 'active').state
    expect(changed.source).toBe('shared-location')
    expect(changed.sessionEpoch).toBe(initial.sessionEpoch + 1)
    expect(changed.motion.motion).toBe('unknown')
    expect(changed.rail.segments).toHaveLength(1)
  })

  test('session replacement clears all shared state', () => {
    const first = processLocationSample(initialLocationPipelineState('shared-location'), sample({ source: 'shared-location' }), 'active').state
    const replaced = replacePipelineSession(first)
    expect(replaced.latest).toBeNull()
    expect(replaced.rail.segments).toHaveLength(0)
    expect(replaced.sessionEpoch).toBe(first.sessionEpoch + 1)
  })
})
