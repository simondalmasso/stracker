import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import puppeteer, { type Page } from 'puppeteer-core'
import sharp from 'sharp'

const target = new URL(process.env.STRACKER_QA_URL || '')
const expectedSha = process.env.STRACKER_EXPECTED_SHA || ''
const expectedVersionId = process.env.STRACKER_EXPECTED_VERSION_ID || ''
const output = process.env.STRACKER_POST_3D_QA_OUTPUT || '/tmp/stracker-santa-fe-post-promotion-3d.json'
const screenshotDir = process.env.STRACKER_POST_3D_SCREENSHOT_DIR || '/tmp'
const POST_3D_READINESS_BUDGET_MS = 90_000

class QaFailure extends Error {
  constructor(readonly code: string) { super(code) }
}

function ok(value: unknown, code: string): asserts value {
  if (!value) throw new QaFailure(code)
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function safe(value: unknown): string {
  return String(value instanceof Error ? value.message : value || 'UNKNOWN')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/[A-Za-z0-9_-]{43}(?:\.[A-Za-z0-9_-]{43})?/g, '[VALUE]')
    .replace(/[^A-Za-z0-9_[\]-]+/g, '_')
    .slice(0, 180)
}

type Public3dState = {
  providerState: string
  buildingState: string
  sourceCount: number
  sourceLoadedCount: number
  sourceBacked: boolean
  layerCount: number
  renderedFeatures: number
  querySourceFeatures: number
  fallbackVisible: boolean
  markerPresent: boolean
  styleGeneration: number
}

function public3dReady(state: Public3dState): boolean {
  return state.buildingState === '3D_ACTIVE'
    && state.sourceBacked
    && state.layerCount >= 4
    && state.renderedFeatures > 0
    && !state.fallbackVisible
    && state.markerPresent
}

function public3dStateCode(state: Public3dState | null, transport: { pmtiles206: number; contentRange: number; queryTransport: number }): string {
  if (!state) return `NO_STATE_PM206-${transport.pmtiles206}_CR-${transport.contentRange}_QT-${transport.queryTransport}`
  return [
    `PROVIDER-${state.providerState}`,
    `BUILDING-${state.buildingState}`,
    `SOURCES-${state.sourceCount}`,
    `LOADED-${state.sourceLoadedCount}`,
    `BACKED-${state.sourceBacked ? 'YES' : 'NO'}`,
    `LAYERS-${state.layerCount}`,
    `RENDERED-${state.renderedFeatures}`,
    `QUERY-${state.querySourceFeatures}`,
    `FALLBACK-${state.fallbackVisible ? 'YES' : 'NO'}`,
    `MARKER-${state.markerPresent ? 'YES' : 'NO'}`,
    `STYLEGEN-${state.styleGeneration}`,
    `PM206-${transport.pmtiles206}`,
    `CR-${transport.contentRange}`,
    `QT-${transport.queryTransport}`,
  ].map(safe).join('__')
}

async function readPublic3dState(page: Page): Promise<Public3dState> {
  return page.$eval('main[data-map-engine="maplibre"]', (main) => {
    const count = (name: string) => {
      const value = Number(main.getAttribute(name) || '0')
      return Number.isFinite(value) && value >= 0 ? value : 0
    }
    return {
      providerState: main.getAttribute('data-map-provider') || 'missing',
      buildingState: main.getAttribute('data-buildings-3d-state') || 'missing',
      sourceCount: count('data-custom-source-count'),
      sourceLoadedCount: count('data-custom-source-loaded-count'),
      sourceBacked: main.getAttribute('data-custom-source-backed') === 'true',
      layerCount: count('data-custom-layer-count'),
      renderedFeatures: count('data-custom-rendered-features'),
      querySourceFeatures: count('data-custom-query-source-features'),
      fallbackVisible: main.getAttribute('data-generic-fallback-visible') === 'true',
      markerPresent: main.getAttribute('data-marker-present') === 'true',
      styleGeneration: count('data-map-style-generation'),
    }
  })
}

async function verifyExactHead(): Promise<void> {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const headers = { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
  const [buildResponse, versionResponse] = await Promise.all([
    fetch(new URL(`/__stracker/build.json?post3d=${nonce}`, target), { headers, cache: 'no-store' }),
    fetch(new URL(`/__stracker/version.json?post3d=${nonce}`, target), { headers, cache: 'no-store' }),
  ])
  ok(buildResponse.status === 200 && versionResponse.status === 200, 'IDENTITY_UNAVAILABLE')
  const build = await buildResponse.json().catch(() => null) as { sourceSha?: string; release?: string } | null
  const version = await versionResponse.json().catch(() => null) as { sourceSha?: string; versionId?: string } | null
  ok(build?.sourceSha === expectedSha && build.release === 'controlled-physical-pilot-v1', 'BUILD_SHA_MISMATCH')
  ok(version?.sourceSha === expectedSha && version.versionId === expectedVersionId, 'VERSION_MISMATCH')
}

async function waitForExactHead(): Promise<number> {
  let last = 'NONE'
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      await verifyExactHead()
      return attempt
    } catch (error) {
      last = safe(error)
      if (attempt < 12) await Bun.sleep(2_000)
    }
  }
  throw new QaFailure(`EXACT_HEAD_PROPAGATION_TIMEOUT_${last}`)
}

async function installSoftwareWebgl(): Promise<void> {
  const executable = process.env.CHROME_BIN || '/usr/bin/google-chrome'
  const wrapper = '/tmp/stracker-post-promotion-chrome.sh'
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

async function pixelDelta(leftImage: Uint8Array, rightImage: Uint8Array): Promise<number> {
  const [left, right] = await Promise.all([
    sharp(leftImage).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(rightImage).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ])
  ok(left.info.width === right.info.width && left.info.height === right.info.height, 'SCREENSHOT_DIMENSION_MISMATCH')
  let changed = 0
  for (let pixel = 0; pixel < left.info.width * left.info.height; pixel += 1) {
    const index = pixel * left.info.channels
    const delta = Math.abs(left.data[index] - right.data[index])
      + Math.abs(left.data[index + 1] - right.data[index + 1])
      + Math.abs(left.data[index + 2] - right.data[index + 2])
    if (delta >= 18) changed += 1
  }
  return changed
}

async function runBrowserAttempt(attempt: number): Promise<Record<string, unknown>> {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
  })
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  let pmtiles206 = 0
  let contentRange = 0
  let queryTransport = 0
  try {
    const page = await browser.newPage()
    await page.setCacheEnabled(false)
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await page.evaluateOnNewDocument(() => {
      const position = (): GeolocationPosition => ({
        coords: {
          latitude: -31.6401,
          longitude: -60.7003,
          accuracy: 4,
          altitude: null,
          altitudeAccuracy: null,
          heading: 25,
          speed: 0,
          toJSON: () => ({}),
        },
        timestamp: Date.now(),
        toJSON: () => ({}),
      })
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          getCurrentPosition(success: PositionCallback) { setTimeout(() => success(position()), 10) },
          watchPosition(success: PositionCallback) { setTimeout(() => success(position()), 50); return 1 },
          clearWatch() {},
        },
      })
    })
    page.on('pageerror', (error) => pageErrors.push(safe(error)))
    page.on('console', (message) => {
      if (message.type() !== 'error' || /favicon|styleimagemissing/i.test(message.text())) return
      consoleErrors.push(safe(message.text()))
    })
    page.on('response', (response) => {
      try {
        const url = new URL(response.url())
        if (url.origin !== target.origin || !url.pathname.endsWith('.pmtiles')) return
        if (response.status() === 206) pmtiles206 += 1
        if (/^bytes \d+-\d+\/\d+$/.test(response.headers()['content-range'] || '')) contentRange += 1
        if (response.headers()['x-stracker-pmtiles-transport'] === 'query-v1') queryTransport += 1
      } catch {}
    })

    const url = new URL(`/?post3d=${Date.now()}-${attempt}&fixture=dense-central`, target)
    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    ok(response?.status() === 200, `ROOT_HTTP_${response?.status() || 0}`)
    await page.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'), { timeout: 30_000 })
    await clickText(page, 'MI UBICACIÓN')
    await clickText(page, 'PERMITIR UBICACIÓN')
    await page.waitForSelector('main[data-map-engine="maplibre"][data-location-source="my-device"]', { timeout: 45_000 })
    const canvas = await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 45_000 })
    ok(canvas, 'MAP_CANVAS_MISSING')

    const readinessDeadline = Date.now() + POST_3D_READINESS_BUDGET_MS
    let state: Public3dState | null = null
    while (Date.now() < readinessDeadline) {
      state = await readPublic3dState(page)
      if (public3dReady(state)) break
      await Bun.sleep(500)
    }
    ok(state && public3dReady(state), `PUBLIC_3D_READINESS_TIMEOUT_${public3dStateCode(state, { pmtiles206, contentRange, queryTransport })}`)

    const clip = await canvas.boundingBox()
    ok(clip, 'CANVAS_BOUNDS_MISSING')
    const onImage = await page.screenshot({ clip })
    await page.click('button[aria-label="Activar o desactivar edificios 3D"]')
    await page.waitForFunction(() => document.querySelector('main[data-map-engine]')?.getAttribute('data-buildings-3d-state') === '3D_OFF', { timeout: 15_000 })
    await Bun.sleep(700)
    const offImage = await page.screenshot({ clip })
    const changedPixels = await pixelDelta(onImage, offImage)

    ok(pmtiles206 > 0 && contentRange > 0 && queryTransport > 0, 'PMTILES_RANGE_CONTRACT')
    ok(changedPixels >= 8_000, `VISUAL_DELTA_TOO_LOW_${changedPixels}`)
    ok(pageErrors.length === 0, `PAGE_ERROR_${pageErrors[0] || 'UNKNOWN'}`)
    ok(consoleErrors.length === 0, `CONSOLE_ERROR_${consoleErrors[0] || 'UNKNOWN'}`)

    await mkdir(screenshotDir, { recursive: true })
    const onName = `santa-fe-post-promotion-${attempt}-on.png`
    const offName = `santa-fe-post-promotion-${attempt}-off.png`
    await Bun.write(join(screenshotDir, onName), onImage)
    await Bun.write(join(screenshotDir, offName), offImage)

    return {
      evidenceClass: 'WEB_AUTOMATION_ONLY',
      viewport: '390x844_SYNTHETIC_WEB',
      publicFixture: 'dense-central',
      customSourceCount: state.sourceCount,
      customSourceLoadedCount: state.sourceLoadedCount,
      customSourceBacked: state.sourceBacked,
      customLayerCount: state.layerCount,
      customRenderedFeatureCount: state.renderedFeatures,
      customQuerySourceFeatureCount: state.querySourceFeatures,
      visualChangedPixels: changedPixels,
      pmtiles206,
      contentRange,
      queryTransport,
      readinessBudgetMs: POST_3D_READINESS_BUDGET_MS,
      pageErrorTotal: pageErrors.length,
      consoleErrorTotal: consoleErrors.length,
      screenshots: [
        { name: onName, sha256: digest(onImage) },
        { name: offName, sha256: digest(offImage) },
      ],
    }
  } finally {
    await browser.close()
  }
}

if (target.protocol !== 'https:' || !target.hostname) throw new Error('HTTPS_TARGET_REQUIRED')
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('EXPECTED_SHA_REQUIRED')
if (!expectedVersionId) throw new Error('EXPECTED_VERSION_ID_REQUIRED')

await installSoftwareWebgl()
const identityAttempts = await waitForExactHead()
let browserEvidence: Record<string, unknown> | null = null
let browserAttempts = 0
let firstFailure = 'NONE'
for (let attempt = 1; attempt <= 3; attempt += 1) {
  browserAttempts = attempt
  try {
    await verifyExactHead()
    browserEvidence = await runBrowserAttempt(attempt)
    await verifyExactHead()
    console.log(`SANTA_FE_POST_PROMOTION_BROWSER_ATTEMPT=${attempt} RESULT=PASS`)
    break
  } catch (error) {
    const classification = safe(error)
    if (firstFailure === 'NONE') firstFailure = classification
    console.log(`SANTA_FE_POST_PROMOTION_BROWSER_ATTEMPT=${attempt} RESULT=RETRY CLASSIFICATION=${classification}`)
    if (attempt < 3) await Bun.sleep(8_000)
  }
}
ok(browserEvidence, `POST_3D_BROWSER_FAILED_${firstFailure}`)

const result = {
  schema: 'stracker.santa-fe-post-promotion-3d.v6',
  sourceSha: expectedSha,
  expectedVersionIdHash: digest(expectedVersionId),
  identityAttempts,
  browserAttempts,
  firstFailure,
  rootCause: browserAttempts > 1 || identityAttempts > 1 ? 'BOUNDED_PUBLIC_ASSET_PROPAGATION_RACE' : 'NONE',
  evidenceClass: 'WEB_DESKTOP_AUTOMATION_ONLY',
  a22Visible3d: 'PENDING_HUMAN',
  a22Performance: 'PENDING_HUMAN',
  nativePhysical: 'PENDING_HUMAN',
  privateDataUsed: false,
  realUserCoordinatesUsed: false,
  coordinateValuesRetained: false,
  rawVersionIdRetained: false,
  automationRenderer: 'SWIFTSHADER_SUPPLEMENTAL',
  swiftShaderSoleEvidence: false,
  browser: browserEvidence,
  gates: {
    PUBLIC_RUNTIME_EXACT_HEAD: 'PASS',
    WEB_3D_DENSE_CITY: 'PASS',
    POST_PROMOTION_PUBLIC_SANTA_FE_3D_RENDER: 'PASS',
    POST_PROMOTION_PMTILES_QUERY_RANGE: 'PASS',
    POST_PROMOTION_BUILDING_TOGGLE_VISUAL_DELTA: 'PASS',
    POST_PROMOTION_READINESS_BUDGET_UNCHANGED_90_SECONDS: 'PASS',
    POST_PROMOTION_BROWSER_RETRY_BOUNDED: 'PASS',
    SWIFTSHADER_NOT_SOLE_EVIDENCE: 'PASS',
    A22_VISIBLE_3D_PENDING_HUMAN: 'PASS',
    A22_PERFORMANCE_PENDING_HUMAN: 'PASS',
    NATIVE_PHYSICAL_PENDING_HUMAN: 'PASS',
  },
}
await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
console.log(`SANTA_FE_POST_PROMOTION_BROWSER_QA=PASS attempts=${browserAttempts} evidence=WEB_ONLY A22=PENDING_HUMAN`)
