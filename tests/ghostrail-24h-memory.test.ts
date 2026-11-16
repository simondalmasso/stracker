import { describe, expect, test } from 'bun:test'
import { GHOSTRAIL_MEMORY_MS, initialGhostRailState, trimGhostRail, updateGhostRail } from '../src/lib/location-source/ghostrail'
import { keyframesFromGhostrail } from '../src/lib/location-source/keyframes-from-rail'
import type { AccuracyFilterResult } from '../src/lib/location-source/accuracy-filter'
import type { GhostRailSegment, LocationSample } from '../src/lib/location-source/contracts'

function accepted(point: { lat: number; lng: number }): AccuracyFilterResult {
  return {
    decision: 'accepted',
    reason: 'visual-movement',
    visualPoint: point,
    distanceM: 1,
    elapsedS: 1,
    derivedSpeedMps: 1,
    state: { stablePoint: point, lastAcceptedSample: null, lastObservedSample: null },
  }
}

function sample(capturedAt: string): LocationSample {
  return {
    source: 'shared-location',
    lat: -31.63,
    lng: -60.70,
    accuracyM: 8,
    capturedAt,
    receivedAt: new Date().toISOString(),
    speedMps: 1,
    headingDeg: null,
  }
}

describe('GhostRail 24-hour memory', () => {
  test('keeps accepted historical points inside the 24-hour window', () => {
    const point = sample(new Date(Date.now() - 6 * 60 * 60_000).toISOString())
    const state = updateGhostRail(initialGhostRailState('shared-location'), {
      sample: point,
      filter: accepted(point),
      sessionEpoch: 0,
    })
    expect(state.segments.flatMap((segment) => segment.points)).toHaveLength(1)
  })

  test('rejects points older than the memory window', () => {
    const point = sample(new Date(Date.now() - GHOSTRAIL_MEMORY_MS - 1_000).toISOString())
    const state = updateGhostRail(initialGhostRailState('shared-location'), {
      sample: point,
      filter: accepted(point),
      sessionEpoch: 0,
    })
    expect(state.segments).toHaveLength(0)
  })

  test('prunes segments whose observed end is outside the 24-hour window', () => {
    const now = Date.now()
    const state = {
      source: 'shared-location' as const,
      sessionEpoch: 0,
      segments: [
        { id: 'old', source: 'shared-location' as const, sessionEpoch: 0, startedAt: new Date(now - GHOSTRAIL_MEMORY_MS - 2_000).toISOString(), endedAt: new Date(now - GHOSTRAIL_MEMORY_MS - 1_000).toISOString(), points: [{ lat: -31.63, lng: -60.70 }] },
        { id: 'recent', source: 'shared-location' as const, sessionEpoch: 0, startedAt: new Date(now - 60_000).toISOString(), endedAt: new Date(now - 30_000).toISOString(), points: [{ lat: -31.64, lng: -60.71 }] },
      ],
    }
    expect(trimGhostRail(state).segments.map((segment) => segment.id)).toEqual(['recent'])
  })
})

describe('EVENTOS 24H keyframes', () => {
  test('keeps exact segment boundary events observed and reconstructed interior events inferred', () => {
    const start = new Date(Date.now() - 30 * 60_000).toISOString()
    const end = new Date(Date.now() - 20 * 60_000).toISOString()
    const segments: GhostRailSegment[] = [{
      id: 'rail',
      source: 'shared-location',
      sessionEpoch: 0,
      startedAt: start,
      endedAt: end,
      points: [
        { lat: -31.6300, lng: -60.7000 },
        { lat: -31.6300, lng: -60.6970 },
        { lat: -31.6330, lng: -60.6970 },
      ],
    }]
    const frames = keyframesFromGhostrail(segments)
    expect(frames[0]).toMatchObject({ type: 'session_observation_start', provenance: 'observed', at: start })
    expect(frames.some((frame) => frame.type === 'significant_displacement' && frame.provenance === 'inferred')).toBe(true)
  })

  test('marks discontinuities between observed segments as data gaps', () => {
    const now = Date.now()
    const segments: GhostRailSegment[] = [
      { id: 'a', source: 'shared-location', sessionEpoch: 0, startedAt: new Date(now - 40 * 60_000).toISOString(), endedAt: new Date(now - 39 * 60_000).toISOString(), points: [{ lat: -31.63, lng: -60.70 }] },
      { id: 'b', source: 'shared-location', sessionEpoch: 0, startedAt: new Date(now - 10 * 60_000).toISOString(), endedAt: new Date(now - 9 * 60_000).toISOString(), points: [{ lat: -31.64, lng: -60.71 }] },
    ]
    const frames = keyframesFromGhostrail(segments)
    expect(frames.map((frame) => frame.type)).toContain('data_gap_start')
    expect(frames.map((frame) => frame.type)).toContain('data_gap_recovered')
  })
})
