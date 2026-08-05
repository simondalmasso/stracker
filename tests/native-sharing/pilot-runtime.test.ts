import '../cookie-session/cookie-session.test'
import { describe, expect, test } from 'bun:test'
import { freshnessFromTimestamp } from '../../src/lib/location-source/contracts'
import { initialCameraControllerState, MAP_PERSPECTIVE_PITCH_DEG, planCamera } from '../../src/lib/location-source/camera-controller'
import { configureBuildings3d } from '../../src/lib/location-source/map-engine/openfreemap-style'
import {
  PILOT_RETRY_DELAYS_MS,
  buildPilotDiagnostic,
  pilotAccuracyState,
  pilotBrowserAndOsClass,
  pilotLastSuccessAgeBucket,
  serializePilotDiagnostic,
} from '../../src/lib/location-source/pilot-runtime'

describe('controlled physical pilot runtime', () => {
  test('uses exact shared-location freshness thresholds', () => {
    const now = Date.parse('2026-08-02T12:00:00.000Z')
    const at = (seconds: number) => new Date(now - seconds * 1_000).toISOString()
    expect(freshnessFromTimestamp('shared-location', at(0), now)).toBe('fresh')
    expect(freshnessFromTimestamp('shared-location', at(15), now)).toBe('fresh')
    expect(freshnessFromTimestamp('shared-location', at(16), now)).toBe('delayed')
    expect(freshnessFromTimestamp('shared-location', at(45), now)).toBe('delayed')
    expect(freshnessFromTimestamp('shared-location', at(46), now)).toBe('stale')
    expect(freshnessFromTimestamp('shared-location', at(600), now)).toBe('stale')
  })

  test('keeps retry schedule finite and accuracy non-coordinate', () => {
    expect(PILOT_RETRY_DELAYS_MS).toEqual([1_000, 3_000, 5_000])
    expect(pilotAccuracyState(null)).toBe('unknown')
    expect(pilotAccuracyState(12)).toBe('good')
    expect(pilotAccuracyState(35)).toBe('fair')
    expect(pilotAccuracyState(80)).toBe('low')
  })

  test('keeps real map perspective visible at rest and with reduced motion', () => {
    const overview = planCamera({
      current: initialCameraControllerState(),
      motion: 'unknown',
      hasPoint: true,
      recenter: true,
      reducedMotion: false,
    })
    expect(overview.pitchDeg).toBe(MAP_PERSPECTIVE_PITCH_DEG)

    const stationaryReduced = planCamera({
      current: initialCameraControllerState(),
      motion: 'stationary',
      hasPoint: true,
      recenter: true,
      reducedMotion: true,
    })
    expect(stationaryReduced.pitchDeg).toBe(MAP_PERSPECTIVE_PITCH_DEG)
    expect(stationaryReduced.animate).toBe(false)
  })

  test('uses one controlled building extrusion and makes the toggle authoritative', () => {
    const layers: Array<Record<string, unknown>> = [
      { id: 'building-3d-native', type: 'fill-extrusion', source: 'openfreemap', 'source-layer': 'building' },
      { id: 'place-label', type: 'symbol', source: 'openfreemap', 'source-layer': 'place' },
    ]
    const visibility = new Map<string, string>()
    const map = {
      getStyle: () => ({ sources: { openfreemap: { type: 'vector' } }, layers }),
      getLayer: (id: string) => layers.find((layer) => layer.id === id),
      setLayoutProperty: (id: string, _property: string, value: string) => visibility.set(id, value),
      addLayer: (layer: Record<string, unknown>) => layers.push(layer),
      setLight: () => undefined,
    }

    expect(configureBuildings3d(map as never, { enabled: true, density: 'full' })).toBe(true)
    const controlled = layers.find((layer) => layer.id === 'stracker-buildings-3d')
    expect(controlled?.type).toBe('fill-extrusion')
    expect(controlled?.source).toBe('openfreemap')
    expect(controlled?.['source-layer']).toBe('building')
    expect(visibility.get('building-3d-native')).toBe('none')

    expect(configureBuildings3d(map as never, { enabled: false, density: 'full' })).toBe(true)
    expect(visibility.get('stracker-buildings-3d')).toBe('none')
  })

  test('classifies last-success age without timestamps in output', () => {
    const now = Date.parse('2026-08-02T12:00:00.000Z')
    expect(pilotLastSuccessAgeBucket(null, now)).toBe('NEVER')
    expect(pilotLastSuccessAgeBucket(new Date(now - 15_000).toISOString(), now)).toBe('FRESH_0_TO_15_SECONDS')
    expect(pilotLastSuccessAgeBucket(new Date(now - 16_000).toISOString(), now)).toBe('DELAYED_16_TO_45_SECONDS')
    expect(pilotLastSuccessAgeBucket(new Date(now - 46_000).toISOString(), now)).toBe('STALE_OVER_45_SECONDS')
  })

  test('diagnostic contains only the approved bounded fields', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        userAgent: 'Mozilla/5.0 (Linux; Android 13) Chrome/150.0.0.0',
        onLine: false,
        permissions: { query: async () => ({ state: 'denied' }) },
      },
    })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { visibilityState: 'hidden' },
    })
    const summary = await buildPilotDiagnostic({
      identity: { buildSha: 'a'.repeat(40), versionId: 'version-redacted-shape' },
      wakeLockSupported: true,
      wakeLockHeld: false,
      lastHttpStatusCategory: 'NETWORK_ERROR',
      pointAttemptCount: 3,
      pointSuccessCount: 1,
      lastSuccessAt: null,
    })
    expect(pilotBrowserAndOsClass(navigator.userAgent)).toBe('ANDROID_CHROME')
    expect(Object.keys(summary).sort()).toEqual([
      'BROWSER_AND_OS_CLASS',
      'BUILD_SHA',
      'GEOLOCATION_PERMISSION_STATE',
      'LAST_HTTP_STATUS_CATEGORY',
      'LAST_SUCCESS_AGE_BUCKET',
      'NETWORK_ONLINE_STATE',
      'PAGE_VISIBILITY_STATE',
      'POINT_ATTEMPT_COUNT',
      'POINT_SUCCESS_COUNT',
      'VERSION_ID',
      'WAKE_LOCK_SUPPORTED_AND_HELD',
    ].sort())
    const serialized = serializePilotDiagnostic(summary)
    for (const forbidden of ['latitude', 'longitude', 'accuracyM', 'capability', 'viewerSession', 'Authorization', 'sessionId', '#v=']) {
      expect(serialized).not.toContain(forbidden)
    }
  })
})
