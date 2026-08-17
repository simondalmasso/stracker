import { describe, expect, test } from 'bun:test'

const cookiePanelPath = 'src/components/mobile/CookieSessionPanel.tsx'
const cityRuntimePath = 'src/lib/location-source/map-engine/santa-fe-city-runtime.ts'
const openFreeMapStylePath = 'src/lib/location-source/map-engine/openfreemap-style.ts'
const releaseWrapperPath = 'scripts/release/cloudflare-controlled-physical-pilot-release.sh'
const publicQaPath = 'scripts/release/shared-cookie-camera-continuity-base.ts'
const publicQaLauncherPath = 'scripts/release/shared-cookie-camera-continuity-qa.ts'
const publicQaPatcherPath = 'scripts/release/materialize-order002-shared-camera-fallback.py'
const post3dQaPath = 'scripts/release/santa-fe-post-promotion-browser-qa.ts'

describe('ORDER-002 desktop shared-session continuity contract', () => {
  test('background UI polling reads durable server state instead of forcing Google probes', async () => {
    const source = await Bun.file(cookiePanelPath).text()
    expect(source).toContain('SERVER_STATE_POLL_INTERVAL_MS')
    expect(source).toContain('await syncServerState()')
    expect(source).toContain('await hydrate(current, false)')
    expect(source).toContain('await hydrate(current, true)')
    expect(source.match(/refreshCookieSession\(/g)?.length).toBe(1)
    expect(source).not.toContain('timer = setTimeout(async () => { await doRefresh()')
    expect(source).not.toContain('const online = () => { void forceRefresh() }')
  })

  test('Santa Fe custom 3D only owns presentation when visibly healthy and otherwise fails over', async () => {
    const source = await Bun.file(cityRuntimePath).text()
    expect(source).toContain('const healthyEvidence = sourceBacked && renderedFeatureCount > 0')
    expect(source).toContain("const providerState: SantaFe3dProviderState = memory.healthy ? '3D_ACTIVE' : '3D_FALLBACK'")
    expect(source).toContain('genericFallbackVisible: !memory.healthy')
    expect(source).toContain('return memory.healthy')
    expect(source).toContain('loadedSourceIds.length > 0 || renderedFeatureCount > 0')
    expect(source).not.toContain("providerState: SantaFe3dProviderState = memory.healthy ? '3D_ACTIVE' : '3D_LOADING'")
    expect(source).toContain('function ensureCustomLayerPresentation')
    expect(source).toContain("map.getLayoutProperty(layerId, 'visibility') !== 'visible'")
    expect(source).toContain("map.getPaintProperty(layerId, 'fill-extrusion-opacity')")
    expect(source).toContain('const renderedFeatureCount = presentationChanged ? 0 : safeRenderedFeatureCount')
    expect(source).toContain("map.on('render', () => {")
    expect(source).toContain("memory.latestStatus?.eligible && memory.latestStatus.providerState !== '3D_ACTIVE'")
    expect(source).toContain('queueHealthProbe(map, memory)')
    expect(source).toContain('configureBuildings3d(map, { enabled: !memory.healthy, density })')
  })

  test('generic fallback avoids no-op mutations and never treats Santa Fe custom layers as fallback candidates', async () => {
    const source = await Bun.file(openFreeMapStylePath).text()
    expect(source).toContain('CONTROLLED_BUILDING_LAYER_IDS')
    expect(source).toContain('...SANTA_FE_3D_LAYER_IDS')
    expect(source).toContain('if (CONTROLLED_BUILDING_LAYER_IDS.has(layer.id)) continue')
    expect(source).toContain('function styleLayerVisibility')
    expect(source).toContain("styleLayerVisibility(layer) !== 'none'")
    expect(source).toContain("const desiredVisibility = options.enabled && options.density !== 'off' ? 'visible' : 'none'")
    expect(source).toContain('const currentVisibility = styleLayerVisibility(existingGenericLayer)')
    expect(source).toContain('if (currentVisibility !== desiredVisibility)')
  })

  test('post-promotion 3D keeps the 90 second budget and proves toggle OFF by React control plus visual delta', async () => {
    const source = await Bun.file(post3dQaPath).text()
    expect(source).toContain('const POST_3D_READINESS_BUDGET_MS = 90_000')
    expect(source).toContain('const CUSTOM_PRIMARY_GRACE_MS = 30_000')
    expect(source).toContain('const MIN_VISUAL_CHANGED_PIXELS = 8_000')
    expect(source).toContain('PUBLIC_3D_READINESS_TIMEOUT_')
    expect(source).toContain('SANTA_FE_POST_PROMOTION_READINESS_TIMEOUT')
    expect(source).toContain("state.buildingState === '3D_ACTIVE'")
    expect(source).toContain("state.buildingState === '3D_FALLBACK'")
    expect(source).toContain('fallbackVisible')
    expect(source).toContain('primaryGraceDeadline')
    expect(source).toContain('while (!custom3dReady(state) && Date.now() < primaryGraceDeadline)')
    expect(source).toContain("getAttribute('aria-pressed') === 'false'")
    expect(source).toContain('toggleControlOffConfirmed: true')
    expect(source).toContain('VISUAL_DELTA_TOO_LOW_')
    expect(source).toContain('POST_PROMOTION_BUILDING_TOGGLE_CONTROL_OFF')
    expect(source).toContain('POST_PROMOTION_BUILDING_TOGGLE_VISUAL_DELTA')
    expect(source).toContain('PMTILES_RANGE_CONTRACT')
    expect(source).toContain('GENERIC_FALLBACK_WHEN_CUSTOM_NOT_HEALTHY')
    expect(source).toContain('NO_FALLBACK_SUPPRESSION_BY_BOUNDARY_ONLY')
    expect(source).not.toContain("waitForFunction(() => document.querySelector('main[data-map-engine]')?.getAttribute('data-buildings-3d-state') === '3D_OFF'")
    expect(source).not.toContain('POST_3D_READINESS_BUDGET_MS = 120_000')
  })

  test('public release keeps rollback armed through the desktop shared-camera smoke', async () => {
    const wrapper = await Bun.file(releaseWrapperPath).text()
    expect(wrapper).toContain('shared-cookie-camera-continuity-qa.ts')
    expect(wrapper).toContain('ORDER002_SHARED_COOKIE_CAMERA_CONTINUITY_QA=PASS')
    expect(wrapper).toContain("'order002SharedCookieCameraContinuity': shared_camera")
    expect(wrapper.indexOf('ORDER002_SHARED_COOKIE_CAMERA_CONTINUITY_QA=PASS')).toBeLessThan(wrapper.lastIndexOf('rollback_required=0'))
  })

  test('desktop public regression materializes fallback acceptance without weakening session or GhostRail invariants', async () => {
    const [base, launcher, patcher] = await Promise.all([
      Bun.file(publicQaPath).text(),
      Bun.file(publicQaLauncherPath).text(),
      Bun.file(publicQaPatcherPath).text(),
    ])
    for (const marker of ['zoom-in-max', 'zoom-out', 'pan', 'rotate', 'pitch', 'recenter']) expect(base).toContain(marker)
    expect(base).toContain("clickText(page, 'UBICACIÓN COMPARTIDA')")
    expect(base).toContain("clickText(page, 'SESIÓN DE GOOGLE MAPS')")
    expect(base).toContain('SESSION_IDENTITY_SURVIVES_CAMERA_INTERACTION')
    expect(base).toContain('GHOSTRAIL_SURVIVES_CAMERA_INTERACTION')
    expect(base).toContain('CAMERA_INTERACTION_DOES_NOT_DELETE_SESSION')
    expect(base).toContain('BACKGROUND_UI_POLL_DOES_NOT_FORCE_GOOGLE_PROBE')
    expect(base).toContain('realCookiesUsed: false')
    expect(base).toContain('privateDataUsed: false')
    expect(launcher).toContain('shared-cookie-camera-continuity-base.ts')
    expect(launcher).toContain('materialize-order002-shared-camera-fallback.py')
    expect(patcher).toContain("data-buildings-3d-state') === '3D_FALLBACK'")
    expect(patcher).toContain("state.buildingState === '3D_FALLBACK'")
    expect(patcher).toContain('VALID_3D_REPRESENTATION_SURVIVES_CAMERA_INTERACTION')
    expect(patcher).toContain('GENERIC_FALLBACK_ALLOWED_WHEN_CUSTOM_UNHEALTHY')
    expect(patcher).toContain('EXPECTED_ONCE_OBSERVED_')
  })
})
