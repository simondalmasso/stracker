import '../cookie-session/cookie-session.test'
import { describe, expect, test } from 'bun:test'
import { freshnessFromTimestamp } from '../../src/lib/location-source/contracts'
import { initialCameraControllerState, MAP_PERSPECTIVE_PITCH_DEG, planCamera } from '../../src/lib/location-source/camera-controller'
import { configureBuildings3d } from '../../src/lib/location-source/map-engine/openfreemap-style'
import { parseAuthorizedViewerLink, STRACKER_PUBLIC_ORIGIN } from '../../src/lib/location-source/viewer-link-policy'
import { runMap3dRuntimeQa } from '../native-sharing-cloudflare/map-3d-runtime-qa'
import {
  clearPersistedViewerSession,
  persistViewerSession,
  readPersistedViewerSession,
  VIEWER_SESSION_STORAGE_KEY,
  type SessionStorageLike,
} from '../../src/lib/location-source/viewer-session-recovery'
import {
  PILOT_RETRY_DELAYS_MS,
  buildPilotDiagnostic,
  pilotAccuracyState,
  pilotBrowserAndOsClass,
  pilotLastSuccessAgeBucket,
  serializePilotDiagnostic,
} from '../../src/lib/location-source/pilot-runtime'

class MemorySessionStorage implements SessionStorageLike {
  values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

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
      setPaintProperty: () => undefined,
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

  test('accepts only strict URLs from the authorized STRACKER runtime', () => {
    const capability = `${'a'.repeat(43)}.${'b'.repeat(43)}`
    const official = `${STRACKER_PUBLIC_ORIGIN}/shared#v=${capability}`
    expect(parseAuthorizedViewerLink(official)?.capability).toBe(capability)
    expect(parseAuthorizedViewerLink(`${official}&v=${capability}`)).toBeNull()
    expect(parseAuthorizedViewerLink(`${STRACKER_PUBLIC_ORIGIN}/shared?next=x#v=${capability}`)).toBeNull()
    expect(parseAuthorizedViewerLink(`${STRACKER_PUBLIC_ORIGIN}/share#v=${capability}`)).toBeNull()
    expect(parseAuthorizedViewerLink(`https://evil.example/shared#v=${capability}`)).toBeNull()
    expect(parseAuthorizedViewerLink(`http://stracker.simondalmasso44.workers.dev/shared#v=${capability}`)).toBeNull()
    expect(parseAuthorizedViewerLink(`https://user@stracker.simondalmasso44.workers.dev/shared#v=${capability}`)).toBeNull()
    expect(parseAuthorizedViewerLink(capability)).toBeNull()

    const localOrigin = 'http://127.0.0.1:8787'
    expect(parseAuthorizedViewerLink(`${localOrigin}/shared/#v=${capability}`, localOrigin)?.capability).toBe(capability)
    expect(parseAuthorizedViewerLink(`http://localhost:8787/shared#v=${capability}`, localOrigin)).toBeNull()
  })

  test('persists only the scoped viewer session in sessionStorage and enforces TTL', () => {
    const now = Date.parse('2026-08-06T03:30:00.000Z')
    const storage = new MemorySessionStorage()
    const session = {
      sessionId: 'a'.repeat(43),
      viewerSessionToken: 'b'.repeat(43),
      viewerGeneration: 1,
      expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    }
    expect(persistViewerSession(session, storage)).toBe(true)
    expect(readPersistedViewerSession(storage, now)).toEqual(session)
    const raw = storage.getItem(VIEWER_SESSION_STORAGE_KEY) ?? ''
    expect(raw).not.toContain('viewerCapability')
    expect(raw).not.toContain('emitterToken')
    expect(raw).not.toContain('cookie')

    expect(readPersistedViewerSession(storage, now + 61 * 60 * 1000)).toBeNull()
    expect(storage.getItem(VIEWER_SESSION_STORAGE_KEY)).toBeNull()
    expect(persistViewerSession(session, storage)).toBe(true)
    clearPersistedViewerSession(storage)
    expect(storage.getItem(VIEWER_SESSION_STORAGE_KEY)).toBeNull()
  })

  test('rejects malformed or overlong viewer recovery state', () => {
    const now = Date.parse('2026-08-06T03:30:00.000Z')
    const storage = new MemorySessionStorage()
    storage.setItem(VIEWER_SESSION_STORAGE_KEY, JSON.stringify({
      sessionId: 'a'.repeat(43),
      viewerSessionToken: 'b'.repeat(43),
      viewerGeneration: 1,
      expiresAt: new Date(now + 5 * 60 * 60 * 1000).toISOString(),
    }))
    expect(readPersistedViewerSession(storage, now)).toBeNull()
    expect(storage.getItem(VIEWER_SESSION_STORAGE_KEY)).toBeNull()
  })

  test('MAP_3D_RUNTIME_TESTS renders public OSM buildings with visible toggle effect', async () => {
    const result = await runMap3dRuntimeQa()
    expect(result.renderedFeatureCount).toBeGreaterThan(0)
    expect(result.gates.MAP_3D_RUNTIME_TESTS).toBe('PASS')
    expect(result.gates.BUILDING_TOGGLE_VISIBLE_EFFECT).toBe('PASS')
    expect(result.gates.MARKER_ABOVE_BUILDINGS).toBe('PASS')
    expect(result.gates.LABELS_USABLE_ABOVE_BUILDINGS).toBe('PASS')
    expect(result.realUserCoordinatesUsed).toBe(false)
    expect(result.coordinateValuesRetained).toBe(false)
  }, 120_000)

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
