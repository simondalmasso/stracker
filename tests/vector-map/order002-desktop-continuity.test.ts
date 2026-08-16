import { describe, expect, test } from 'bun:test'

const cookiePanelPath = 'src/components/mobile/CookieSessionPanel.tsx'
const cityRuntimePath = 'src/lib/location-source/map-engine/santa-fe-city-runtime.ts'
const openFreeMapStylePath = 'src/lib/location-source/map-engine/openfreemap-style.ts'
const releaseWrapperPath = 'scripts/release/cloudflare-controlled-physical-pilot-release.sh'
const publicQaPath = 'scripts/release/shared-cookie-camera-continuity-qa.ts'
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
    expect(source).not.toContain('genericFallbackVisible: false,\n    styleGeneration: memory.styleGeneration,\n  })\n  return true')
    expect(source).toContain('function ensureCustomLayerPresentation')
    expect(source).toContain("map.getLayoutProperty(layerId, 'visibility') !== 'visible'")
    expect(source).toContain("map.getPaintProperty(layerId, 'fill-extrusion-opacity')")
    expect(source).toContain('const renderedFeatureCount = presentationChanged ? 0 : safeRenderedFeatureCount')
    expect(source).toContain("memory.latestStatus?.eligible && memory.latestStatus.providerState !== '3D_ACTIVE'")
    expect(source).not.toContain("map.on('render'")
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

  test('post-promotion 3D keeps the 90 second budget and accepts only a real custom or generic 3D representation', async () => {
    const source = await Bun.file(post3dQaPath).text()
    expect(source).toContain('const POST_3D_READINESS_BUDGET_MS = 90_000')
    expect(source).toContain('PUBLIC_3D_READINESS_TIMEOUT_')
    expect(source).toContain('SANTA_FE_POST_PROMOTION_READINESS_TIMEOUT')
    expect(source).toContain('3D_ACTIVE')
    expect(source).toContain('3D_FALLBACK')
    expect(source).toContain('fallbackVisible')
    expect(source).toContain('VISUAL_DELTA_TOO_LOW_')
    expect(source).toContain('PMTILES_RANGE_CONTRACT')
    expect(source).not.toContain('POST_3D_READINESS_BUDGET_MS = 120_000')
  })

  test('public release keeps rollback armed through the desktop shared-camera smoke', async () => {
    const wrapper = await Bun.file(releaseWrapperPath).text()
    expect(wrapper).toContain('shared-cookie-camera-continuity-qa.ts')
    expect(wrapper).toContain('ORDER002_SHARED_COOKIE_CAMERA_CONTINUITY_QA=PASS')
    expect(wrapper).toContain("'order002SharedCookieCameraContinuity': shared_camera")
    expect(wrapper.indexOf('ORDER002_SHARED_COOKIE_CAMERA_CONTINUITY_QA=PASS')).toBeLessThan(wrapper.lastIndexOf('rollback_required=0'))
  })

  test('desktop public regression covers all owner-reported camera operations without real credentials', async () => {
    const qa = await Bun.file(publicQaPath).text()
    for (const marker of ['zoom-in-max', 'zoom-out', 'pan', 'rotate', 'pitch', 'recenter']) expect(qa).toContain(marker)
    expect(qa).toContain("clickText(page, 'UBICACIÓN COMPARTIDA')")
    expect(qa).toContain("clickText(page, 'SESIÓN DE GOOGLE MAPS')")
    expect(qa).toContain('SESSION_IDENTITY_SURVIVES_CAMERA_INTERACTION')
    expect(qa).toContain('GHOSTRAIL_SURVIVES_CAMERA_INTERACTION')
    expect(qa).toContain('CAMERA_INTERACTION_DOES_NOT_DELETE_SESSION')
    expect(qa).toContain('BACKGROUND_UI_POLL_DOES_NOT_FORCE_GOOGLE_PROBE')
    expect(qa).toContain("buildingState === '3D_ACTIVE'")
    expect(qa).toContain("buildingState === '3D_FALLBACK'")
    expect(qa).toContain('realCookiesUsed: false')
    expect(qa).toContain('privateDataUsed: false')
  })
})
