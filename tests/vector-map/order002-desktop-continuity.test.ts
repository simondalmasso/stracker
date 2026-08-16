import { describe, expect, test } from 'bun:test'

const cookiePanelPath = 'src/components/mobile/CookieSessionPanel.tsx'
const cityRuntimePath = 'src/lib/location-source/map-engine/santa-fe-city-runtime.ts'
const releaseWrapperPath = 'scripts/release/cloudflare-controlled-physical-pilot-release.sh'
const publicQaPath = 'scripts/release/shared-cookie-camera-continuity-qa.ts'

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

  test('3D ACTIVE requires rendered custom geometry and continues probing until rendered', async () => {
    const source = await Bun.file(cityRuntimePath).text()
    expect(source).toContain('const healthyEvidence = sourceBackedNow && renderedFeatureCount > 0')
    expect(source).toContain("memory.latestStatus.providerState !== '3D_ACTIVE'")
    expect(source).toContain("map.on('render'")
    expect(source).toContain('queueHealthProbe(map, memory)')
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
    expect(qa).toContain('realCookiesUsed: false')
    expect(qa).toContain('privateDataUsed: false')
  })
})
