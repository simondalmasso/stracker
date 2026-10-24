import { createHash } from 'node:crypto'
import puppeteer, { type HTTPRequest, type Page } from 'puppeteer-core'

const target = new URL(process.env.STRACKER_QA_URL || '')
const expectedSha = process.env.STRACKER_EXPECTED_SHA || ''
const expectedVersionId = process.env.STRACKER_EXPECTED_VERSION_ID || ''
const output = process.env.STRACKER_SHARED_CAMERA_QA_OUTPUT || '/tmp/stracker-shared-cookie-camera-continuity.json'
const HANDLE_KEY = 'stracker.cookie.handle.v2'

class QaFailure extends Error {
  constructor(readonly code: string) { super(code) }
}

function ok(value: unknown, code: string): asserts value {
  if (!value) throw new QaFailure(code)
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function token(label: string): string {
  return createHash('sha256').update(`stracker-order-002-${label}`).digest('base64url').slice(0, 43)
}

function safe(value: unknown): string {
  return String(value instanceof Error ? value.message : value || 'UNKNOWN')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/[A-Za-z0-9_-]{43}(?:\.[A-Za-z0-9_-]{43})?/g, '[VALUE]')
    .replace(/[^A-Za-z0-9_[\]-]+/g, '_')
    .slice(0, 180)
}

async function verifyExactHead(): Promise<void> {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const headers = { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
  const [buildResponse, versionResponse] = await Promise.all([
    fetch(new URL(`/__stracker/build.json?shared-camera=${nonce}`, target), { headers, cache: 'no-store' }),
    fetch(new URL(`/__stracker/version.json?shared-camera=${nonce}`, target), { headers, cache: 'no-store' }),
  ])
  ok(buildResponse.status === 200 && versionResponse.status === 200, 'IDENTITY_UNAVAILABLE')
  const build = await buildResponse.json().catch(() => null) as { sourceSha?: string; release?: string } | null
  const version = await versionResponse.json().catch(() => null) as { sourceSha?: string; versionId?: string } | null
  ok(build?.sourceSha === expectedSha && build.release === 'controlled-physical-pilot-v1', 'BUILD_SHA_MISMATCH')
  ok(version?.sourceSha === expectedSha && version.versionId === expectedVersionId, 'VERSION_MISMATCH')
}

async function installSoftwareWebgl(): Promise<void> {
  const executable = process.env.CHROME_BIN || '/usr/bin/google-chrome'
  const wrapper = '/tmp/stracker-shared-camera-chrome.sh'
  await Bun.write(wrapper, `#!/usr/bin/env bash\nexec ${JSON.stringify(executable)} --use-angle=swiftshader "$@"\n`)
  const chmod = Bun.spawnSync(['chmod', '700', wrapper])
  ok(chmod.exitCode === 0, 'WEBGL_WRAPPER_INSTALL_FAILED')
  process.env.CHROME_BIN = wrapper
}

async function clickText(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (value) => [...document.querySelectorAll('button')].some((button) => button.textContent?.toUpperCase().includes(String(value).toUpperCase())),
    { timeout: 30_000 }, text,
  )
  await page.$$eval('button', (buttons, value) => {
    const button = buttons.find((candidate) => candidate.textContent?.toUpperCase().includes(String(value).toUpperCase())) as HTMLButtonElement | undefined
    if (!button) throw new Error('BUTTON_NOT_FOUND')
    button.click()
  }, text)
}

type ContinuityState = {
  flow: string
  mapEngine: string
  buildingState: string
  renderedFeatures: number
  customLayerCount: number
  fallbackVisible: boolean
  ghostrailObserved: number
  ghostrailInferred: number
  keyframes: number
  canvasCount: number
  sessionHandlePresent: boolean
  sessionIdentityStable: boolean
}

async function readContinuityState(page: Page, expected: { sessionId: string; ownerToken: string; mobilityScope: string }): Promise<ContinuityState> {
  return page.evaluate((identity) => {
    const main = document.querySelector('main[data-map-engine]')
    const count = (name: string) => Number(main?.getAttribute(name) || '0') || 0
    let stored: { sessionId?: string; ownerToken?: string; mobilityScope?: string; storagePolicy?: string } | null = null
    try { stored = JSON.parse(sessionStorage.getItem('stracker.cookie.handle.v2') || 'null') as typeof stored } catch {}
    return {
      flow: main?.getAttribute('data-location-source') || 'missing',
      mapEngine: main?.getAttribute('data-map-engine') || 'missing',
      buildingState: main?.getAttribute('data-buildings-3d-state') || 'missing',
      renderedFeatures: count('data-custom-rendered-features'),
      customLayerCount: count('data-custom-layer-count'),
      fallbackVisible: main?.getAttribute('data-generic-fallback-visible') === 'true',
      ghostrailObserved: count('data-ghostrail-observed'),
      ghostrailInferred: count('data-ghostrail-inferred'),
      keyframes: count('data-keyframes'),
      canvasCount: document.querySelectorAll('canvas.maplibregl-canvas').length,
      sessionHandlePresent: Boolean(stored),
      sessionIdentityStable: stored?.sessionId === identity.sessionId
        && stored?.ownerToken === identity.ownerToken
        && stored?.mobilityScope === identity.mobilityScope
        && stored?.storagePolicy === 'encrypted-durable',
    }
  }, expected)
}

async function requireContinuity(page: Page, label: string, identity: { sessionId: string; ownerToken: string; mobilityScope: string }): Promise<ContinuityState> {
  await page.waitForFunction((expected) => {
    const main = document.querySelector('main[data-map-engine="maplibre"][data-location-source="shared-location"]')
    if (!main) return false
    let stored: { sessionId?: string; ownerToken?: string; mobilityScope?: string; storagePolicy?: string } | null = null
    try { stored = JSON.parse(sessionStorage.getItem('stracker.cookie.handle.v2') || 'null') as typeof stored } catch {}
    return stored?.sessionId === expected.sessionId
      && stored?.ownerToken === expected.ownerToken
      && stored?.mobilityScope === expected.mobilityScope
      && stored?.storagePolicy === 'encrypted-durable'
      && main.getAttribute('data-buildings-3d-state') === '3D_ACTIVE'
      && Number(main.getAttribute('data-custom-rendered-features') || '0') > 0
      && Number(main.getAttribute('data-custom-layer-count') || '0') >= 4
      && main.getAttribute('data-generic-fallback-visible') === 'false'
      && Number(main.getAttribute('data-ghostrail-observed') || '0') >= 1
      && Number(main.getAttribute('data-ghostrail-inferred') || '0') >= 1
      && Number(main.getAttribute('data-keyframes') || '0') >= 2
      && document.querySelectorAll('canvas.maplibregl-canvas').length === 1
  }, { timeout: 30_000 }, identity)
  const state = await readContinuityState(page, identity)
  ok(state.flow === 'shared-location', `${label}_SHARED_FLOW_LOST`)
  ok(state.mapEngine === 'maplibre', `${label}_MAP_ENGINE_CHANGED`)
  ok(state.buildingState === '3D_ACTIVE' && state.renderedFeatures > 0 && state.customLayerCount >= 4 && !state.fallbackVisible, `${label}_3D_LOST`)
  ok(state.ghostrailObserved >= 1 && state.ghostrailInferred >= 1 && state.keyframes >= 2, `${label}_GHOSTRAIL_RESET`)
  ok(state.canvasCount === 1, `${label}_MAP_REMOUNT_OR_DUPLICATE`)
  ok(state.sessionHandlePresent && state.sessionIdentityStable, `${label}_SESSION_IDENTITY_LOST`)
  return state
}

if (target.protocol !== 'https:' || !target.hostname) throw new Error('HTTPS_TARGET_REQUIRED')
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('EXPECTED_SHA_REQUIRED')
if (!expectedVersionId) throw new Error('EXPECTED_VERSION_ID_REQUIRED')

await verifyExactHead()
await installSoftwareWebgl()

const identity = {
  sessionId: token('session'),
  ownerToken: token('owner'),
  mobilityScope: token('mobility'),
}
const pageErrors: string[] = []
const consoleErrors: string[] = []
let statusReads = 0
let pointReads = 0
let historyReads = 0
let providerRefreshRequests = 0
let deleteRequests = 0
let unexpectedCookieApiRequests = 0

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
})

try {
  const page = await browser.newPage()
  await page.setCacheEnabled(false)
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await page.evaluateOnNewDocument((key, seededIdentity) => {
    const now = Date.now()
    const handle = {
      state: 'ready',
      policyVersion: 'order-002-synthetic-public-qa',
      format: 'COOKIE_HEADER_STRING',
      cookieCount: 2,
      totalParsed: 2,
      expiredDropped: 0,
      invalidDropped: 0,
      retainedCount: 2,
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
      validatedAt: new Date(now).toISOString(),
      locationAvailable: true,
      sessionId: seededIdentity.sessionId,
      ownerToken: seededIdentity.ownerToken,
      mobilityScope: seededIdentity.mobilityScope,
      storagePolicy: 'encrypted-durable',
    }
    sessionStorage.setItem(key, JSON.stringify(handle))
  }, HANDLE_KEY, identity)

  await page.setRequestInterception(true)
  page.on('pageerror', (error) => pageErrors.push(safe(error)))
  page.on('console', (message) => {
    if (message.type() !== 'error' || /favicon|styleimagemissing/i.test(message.text())) return
    consoleErrors.push(safe(message.text()))
  })
  page.on('request', (request: HTTPRequest) => {
    void (async () => {
      const url = new URL(request.url())
      const sameOrigin = url.origin === target.origin
      if (!sameOrigin || !url.pathname.startsWith('/api/cookie-sessions')) {
        await request.continue()
        return
      }
      const sessionPrefix = `/api/cookie-sessions/${encodeURIComponent(identity.sessionId)}`
      const json = (payload: unknown, status = 200) => request.respond({
        status,
        contentType: 'application/json; charset=utf-8',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify(payload),
      })
      const now = Date.now()
      const status = {
        state: 'ready',
        policyVersion: 'order-002-synthetic-public-qa',
        format: 'COOKIE_HEADER_STRING',
        cookieCount: 2,
        totalParsed: 2,
        expiredDropped: 0,
        invalidDropped: 0,
        retainedCount: 2,
        expiresAt: new Date(now + 60 * 60_000).toISOString(),
        validatedAt: new Date(now).toISOString(),
        locationAvailable: true,
      }
      if (url.pathname === `${sessionPrefix}/status` && request.method() === 'GET') {
        statusReads += 1
        await json(status)
        return
      }
      if (url.pathname === `${sessionPrefix}/point` && request.method() === 'GET') {
        pointReads += 1
        await json({
          state: 'ready',
          point: {
            lat: -31.6401,
            lng: -60.7003,
            accuracyM: 6,
            capturedAt: new Date(now - 1_000).toISOString(),
            observedAt: new Date(now - 800).toISOString(),
            sourceQuality: 'stracker_observed_at',
          },
          validatedAt: new Date(now).toISOString(),
        })
        return
      }
      if (url.pathname === `${sessionPrefix}/history` && request.method() === 'GET') {
        historyReads += 1
        await json({
          state: 'ready',
          windowStart: new Date(now - 24 * 60 * 60_000).toISOString(),
          windowEnd: new Date(now).toISOString(),
          points: [
            { lat: -31.6410, lng: -60.7012, accuracyM: 8, capturedAt: new Date(now - 8 * 60_000).toISOString(), observedAt: new Date(now - 8 * 60_000).toISOString(), provenance: 'observed', sourceQuality: 'provider_timestamp' },
            { lat: -31.6406, lng: -60.7008, accuracyM: 7, capturedAt: new Date(now - 7 * 60_000).toISOString(), observedAt: new Date(now - 7 * 60_000).toISOString(), provenance: 'observed', sourceQuality: 'provider_timestamp' },
            { lat: -31.6401, lng: -60.7003, accuracyM: 6, capturedAt: new Date(now - 1_000).toISOString(), observedAt: new Date(now - 800).toISOString(), provenance: 'observed', sourceQuality: 'stracker_observed_at' },
          ],
          segments: [
            { id: 'observed-public-qa', provenance: 'observed', confidence: 'high', method: 'provider-observed', startedAt: new Date(now - 8 * 60_000).toISOString(), endedAt: new Date(now - 7 * 60_000).toISOString(), points: [{ lat: -31.6410, lng: -60.7012 }, { lat: -31.6406, lng: -60.7008 }] },
            { id: 'inferred-public-qa', provenance: 'inferred', confidence: 'medium', method: 'learned-corridor-prior', startedAt: new Date(now - 7 * 60_000).toISOString(), endedAt: new Date(now - 1_000).toISOString(), points: [{ lat: -31.6406, lng: -60.7008 }, { lat: -31.64035, lng: -60.70055 }, { lat: -31.6401, lng: -60.7003 }] },
          ],
          keyframes: [
            { id: 'start-public-qa', type: 'session_observation_start', at: new Date(now - 8 * 60_000).toISOString(), lat: -31.6410, lng: -60.7012, provenance: 'observed', confidence: 'high' },
            { id: 'gap-public-qa', type: 'mode_change', at: new Date(now - 7 * 60_000).toISOString(), lat: -31.64035, lng: -60.70055, provenance: 'inferred', confidence: 'medium' },
          ],
          rawRetentionHours: 24,
          derivedModelRetentionDays: 30,
          inferenceTruthLabelRequired: true,
        })
        return
      }
      if (url.pathname === `${sessionPrefix}/refresh` && request.method() === 'POST') {
        providerRefreshRequests += 1
        await json(status)
        return
      }
      if (url.pathname === sessionPrefix && request.method() === 'DELETE') {
        deleteRequests += 1
        await json({ ok: true })
        return
      }
      unexpectedCookieApiRequests += 1
      await json({ error: 'REQUEST_INVALID' }, 400)
    })().catch(() => request.abort().catch(() => undefined))
  })

  const rootResponse = await page.goto(new URL(`/?shared-camera=${Date.now()}`, target).href, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  ok(rootResponse?.status() === 200, `ROOT_HTTP_${rootResponse?.status() || 0}`)
  await page.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'), { timeout: 30_000 })
  await clickText(page, 'UBICACIÓN COMPARTIDA')
  await clickText(page, 'SESIÓN DE GOOGLE MAPS')
  await page.waitForSelector('main[data-map-engine="maplibre"][data-location-source="shared-location"]', { timeout: 30_000 })
  const baseline = await requireContinuity(page, 'BASELINE', identity)
  const canvas = await page.$('canvas.maplibregl-canvas')
  const box = await canvas?.boundingBox()
  ok(box, 'MAP_CANVAS_BOUNDS_MISSING')
  const centerX = box.x + box.width * 0.52
  const centerY = box.y + box.height * 0.48
  const states: Record<string, ContinuityState> = { baseline }

  const check = async (label: string) => {
    await Bun.sleep(1_000)
    states[label] = await requireContinuity(page, label.toUpperCase(), identity)
  }

  await page.mouse.move(centerX, centerY)
  await page.mouse.wheel({ deltaY: -1_600 })
  await check('zoom-in-1')
  await page.mouse.wheel({ deltaY: -2_600 })
  await check('zoom-in-max')
  await page.mouse.wheel({ deltaY: 1_400 })
  await check('zoom-out')

  await page.mouse.move(centerX, centerY)
  await page.mouse.down({ button: 'left' })
  await page.mouse.move(centerX + 140, centerY + 45, { steps: 12 })
  await page.mouse.up({ button: 'left' })
  await check('pan')

  await page.mouse.move(centerX, centerY)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(centerX + 160, centerY, { steps: 12 })
  await page.mouse.up({ button: 'right' })
  await check('rotate')

  await page.mouse.move(centerX, centerY)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(centerX, centerY + 130, { steps: 12 })
  await page.mouse.up({ button: 'right' })
  await check('pitch')

  await page.click('button[aria-label="Recentrar mapa"]')
  await check('recenter')

  const readsBeforePassivePoll = statusReads + pointReads + historyReads
  await Bun.sleep(22_000)
  states['after-passive-server-state-poll'] = await requireContinuity(page, 'AFTER_PASSIVE_POLL', identity)
  const readsAfterPassivePoll = statusReads + pointReads + historyReads

  await verifyExactHead()
  ok(readsAfterPassivePoll > readsBeforePassivePoll, 'PASSIVE_SERVER_STATE_POLL_NOT_OBSERVED')
  ok(providerRefreshRequests === 0, `CAMERA_OR_BACKGROUND_TRIGGERED_PROVIDER_REFRESH_${providerRefreshRequests}`)
  ok(deleteRequests === 0, `CAMERA_TRIGGERED_SESSION_DELETE_${deleteRequests}`)
  ok(unexpectedCookieApiRequests === 0, `UNEXPECTED_COOKIE_API_REQUESTS_${unexpectedCookieApiRequests}`)
  ok(pageErrors.length === 0, `PAGE_ERROR_${pageErrors[0] || 'UNKNOWN'}`)
  ok(consoleErrors.length === 0, `CONSOLE_ERROR_${consoleErrors[0] || 'UNKNOWN'}`)

  const result = {
    schema: 'stracker.order-002.shared-cookie-camera-continuity.v1',
    sourceSha: expectedSha,
    expectedVersionIdHash: digest(expectedVersionId),
    environment: 'CHROME_DESKTOP_AUTOMATION',
    flow: 'UBICACION_COMPARTIDA_GOOGLE_SESSION',
    realCookiesUsed: false,
    privateDataUsed: false,
    realUserCoordinatesUsed: false,
    coordinateValuesRetained: false,
    rawSessionHandleRetained: false,
    syntheticSessionIdentityRetained: false,
    cameraOperations: Object.keys(states),
    stateProof: Object.fromEntries(Object.entries(states).map(([name, state]) => [name, {
      buildingState: state.buildingState,
      renderedFeaturesPositive: state.renderedFeatures > 0,
      customLayerCount: state.customLayerCount,
      fallbackVisible: state.fallbackVisible,
      ghostrailObserved: state.ghostrailObserved,
      ghostrailInferred: state.ghostrailInferred,
      keyframes: state.keyframes,
      canvasCount: state.canvasCount,
      sessionHandlePresent: state.sessionHandlePresent,
      sessionIdentityStable: state.sessionIdentityStable,
    }])),
    apiProof: {
      statusReads,
      pointReads,
      historyReads,
      providerRefreshRequests,
      deleteRequests,
      unexpectedCookieApiRequests,
      passiveServerStatePollObserved: readsAfterPassivePoll > readsBeforePassivePoll,
    },
    pageErrorTotal: pageErrors.length,
    consoleErrorTotal: consoleErrors.length,
    gates: {
      PUBLIC_RUNTIME_EXACT_HEAD: 'PASS',
      DESKTOP_SHARED_GOOGLE_SESSION_FLOW: 'PASS',
      SESSION_IDENTITY_SURVIVES_CAMERA_INTERACTION: 'PASS',
      ZOOM_IN_3D_CONTINUITY: 'PASS',
      MAX_ZOOM_3D_CONTINUITY: 'PASS',
      ZOOM_OUT_3D_CONTINUITY: 'PASS',
      PAN_3D_CONTINUITY: 'PASS',
      ROTATE_3D_CONTINUITY: 'PASS',
      PITCH_3D_CONTINUITY: 'PASS',
      RECENTER_3D_CONTINUITY: 'PASS',
      GHOSTRAIL_SURVIVES_CAMERA_INTERACTION: 'PASS',
      SINGLE_MAPLIBRE_INSTANCE_SURVIVES_INTERACTION: 'PASS',
      CAMERA_INTERACTION_DOES_NOT_DELETE_SESSION: 'PASS',
      BACKGROUND_UI_POLL_DOES_NOT_FORCE_GOOGLE_PROBE: 'PASS',
      PASSIVE_SERVER_STATE_POLL_OBSERVED: 'PASS',
      NO_PRIVATE_DATA_IN_DESKTOP_REGRESSION: 'PASS',
    },
  }
  await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
  console.log('ORDER002_SHARED_COOKIE_CAMERA_CONTINUITY_QA=PASS')
} finally {
  await browser.close()
}
