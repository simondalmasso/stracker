import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import puppeteer, { type HTTPRequest, type Page } from 'puppeteer-core'
import sharp from 'sharp'

export interface SantaFePublicBrowserQaOptions {
  targetUrl: string
  requestHeaders?: Record<string, string>
  screenshotDir: string
  screenshotPrefix: string
  coldBudgetMs?: number
  warmBudgetMs?: number
  minimumFps?: number
}

type RuntimeState = {
  providerState: string
  buildings3dState: string
  customSourceBacked: boolean
  customRenderedFeatures: number
  customQuerySourceFeatures: number
  customSourceLoadedCount: number
  customLayerCount: number
  genericFallbackVisible: boolean
  styleGeneration: number
  firstVisibleMs: number | null
  firstInteractiveMs: number | null
  estimatedFpsAttribute: number | null
}

type RunMetrics = RuntimeState & { readyMs: number }
type DiffSignals = {
  changedPixels: number
  meanAbsoluteDelta: number
  verticalEdgePixels: number
  roofSurfacePixels: number
  screenSpaceHeightBuckets: number
  image: Uint8Array
}

class PublicQaFailure extends Error {
  constructor(readonly code: string) { super(code) }
}

function ok(value: unknown, code: string): asserts value {
  if (!value) throw new PublicQaFailure(code)
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sanitized(value: unknown): string {
  return String(value || 'UNKNOWN')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/[A-Za-z0-9_-]{43}(?:\.[A-Za-z0-9_-]{43})?/g, '[CAPABILITY]')
    .replace(/[^A-Z0-9_[\]-]+/gi, '_')
    .slice(0, 160)
}

function stateCode(state: RuntimeState | null): string {
  if (!state) return 'NO_STATE'
  return [
    `PROVIDER-${state.providerState}`,
    `BUILDINGS-${state.buildings3dState}`,
    `BACKED-${state.customSourceBacked ? 'YES' : 'NO'}`,
    `LOADED-${state.customSourceLoadedCount}`,
    `LAYERS-${state.customLayerCount}`,
    `SOURCE-${state.customQuerySourceFeatures}`,
    `RENDERED-${state.customRenderedFeatures}`,
    `FALLBACK-${state.genericFallbackVisible ? 'YES' : 'NO'}`,
  ].map(sanitized).join('__')
}

function customVisualRuntimeReady(state: RuntimeState): boolean {
  return state.buildings3dState === '3D_ACTIVE'
    && state.customLayerCount >= 4
    && !state.genericFallbackVisible
}

async function installFixtureGeolocation(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    let nextId = 1
    const watches = new Map<number, PositionCallback>()
    const point = () => new URL(location.href).searchParams.get('fixture') === 'mixed-rise'
      ? { lat: -31.6237, lng: -60.6738 }
      : { lat: -31.6401, lng: -60.7003 }
    const position = (): GeolocationPosition => {
      const value = point()
      return {
        coords: {
          latitude: value.lat,
          longitude: value.lng,
          accuracy: 4,
          altitude: null,
          altitudeAccuracy: null,
          heading: 25,
          speed: 0,
          toJSON: () => ({}),
        },
        timestamp: Date.now(),
        toJSON: () => ({}),
      }
    }
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success: PositionCallback) { setTimeout(() => success(position()), 10) },
        watchPosition(success: PositionCallback) {
          const id = nextId++
          watches.set(id, success)
          setTimeout(() => { if (watches.has(id)) success(position()) }, 50)
          return id
        },
        clearWatch(id: number) { watches.delete(id) },
      },
    })
  })
}

async function clickText(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (value) => [...document.querySelectorAll('button')]
      .some((button) => button.textContent?.toUpperCase().includes(String(value).toUpperCase())),
    { timeout: 30_000 }, text,
  )
  await page.$$eval('button', (buttons, value) => {
    const button = buttons.find((item) => item.textContent?.toUpperCase().includes(String(value).toUpperCase()))
    if (!(button instanceof HTMLButtonElement)) throw new Error('BUTTON_NOT_FOUND')
    button.click()
  }, text)
}

async function readState(page: Page): Promise<RuntimeState> {
  return page.evaluate(() => {
    const main = document.querySelector('main[data-map-engine="maplibre"]')
    const count = (name: string) => {
      const value = Number(main?.getAttribute(name))
      return Number.isFinite(value) && value >= 0 ? value : 0
    }
    const timing = (name: string) => {
      const value = Number(main?.getAttribute(name))
      return Number.isFinite(value) && value > 0 ? value : null
    }
    return {
      providerState: main?.getAttribute('data-map-provider') || 'missing',
      buildings3dState: main?.getAttribute('data-buildings-3d-state') || 'missing',
      customSourceBacked: main?.getAttribute('data-custom-source-backed') === 'true',
      customRenderedFeatures: count('data-custom-rendered-features'),
      customQuerySourceFeatures: count('data-custom-query-source-features'),
      customSourceLoadedCount: count('data-custom-source-loaded-count'),
      customLayerCount: count('data-custom-layer-count'),
      genericFallbackVisible: main?.getAttribute('data-generic-fallback-visible') === 'true',
      styleGeneration: count('data-map-style-generation'),
      firstVisibleMs: timing('data-map-first-visible-ms'),
      firstInteractiveMs: timing('data-map-first-interactive-ms'),
      estimatedFpsAttribute: timing('data-map-fps'),
    }
  })
}

async function difference(on: Uint8Array, off: Uint8Array): Promise<DiffSignals> {
  const [a, b] = await Promise.all([
    sharp(on).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(off).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ])
  ok(a.info.width === b.info.width && a.info.height === b.info.height, 'SCREENSHOT_DIMENSION_MISMATCH')
  const width = a.info.width
  const height = a.info.height
  const mask = new Uint8Array(width * height)
  const output = new Uint8Array(width * height * 4)
  let changedPixels = 0
  let totalDelta = 0
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const index = pixel * a.info.channels
    const delta = Math.abs(a.data[index] - b.data[index])
      + Math.abs(a.data[index + 1] - b.data[index + 1])
      + Math.abs(a.data[index + 2] - b.data[index + 2])
    totalDelta += delta
    if (delta < 18) continue
    mask[pixel] = 1
    changedPixels += 1
    output[pixel * 4] = 255
    output[pixel * 4 + 1] = 255
    output[pixel * 4 + 2] = 255
    output[pixel * 4 + 3] = 255
  }
  let verticalEdgePixels = 0
  let roofSurfacePixels = 0
  const runs: number[] = []
  for (let x = 1; x < width - 1; x += 1) {
    let run = 0
    for (let y = 1; y < height - 1; y += 1) {
      const pixel = y * width + x
      if (!mask[pixel]) {
        if (run >= 3) runs.push(run)
        run = 0
        continue
      }
      run += 1
      if (!mask[pixel - 1] || !mask[pixel + 1]) verticalEdgePixels += 1
      if (mask[pixel - 1] && mask[pixel + 1] && mask[pixel - width] && mask[pixel + width]) roofSurfacePixels += 1
    }
    if (run >= 3) runs.push(run)
  }
  const buckets = new Set(runs.map((run) => Math.min(12, Math.floor(run / 4))))
  return {
    changedPixels,
    meanAbsoluteDelta: totalDelta / Math.max(1, width * height * 3),
    verticalEdgePixels,
    roofSurfacePixels,
    screenSpaceHeightBuckets: buckets.size,
    image: await sharp(output, { raw: { width, height, channels: 4 } }).png().toBuffer(),
  }
}

async function darkPixelShare(image: Uint8Array): Promise<number> {
  const raster = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let dark = 0
  for (let i = 0; i < raster.data.length; i += raster.info.channels) {
    if (raster.data[i] < 48 && raster.data[i + 1] < 48 && raster.data[i + 2] < 48) dark += 1
  }
  return dark / Math.max(1, raster.info.width * raster.info.height)
}

async function measuredFps(page: Page): Promise<number> {
  return page.evaluate(async () => {
    let frames = 0
    const start = performance.now()
    await new Promise<void>((resolve) => {
      const tick = () => {
        frames += 1
        if (performance.now() - start >= 2_000) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    return Math.round(frames * 1_000 / Math.max(1, performance.now() - start))
  })
}

export async function runSantaFePublicBrowserQa(options: SantaFePublicBrowserQaOptions): Promise<Record<string, unknown>> {
  const target = new URL(options.targetUrl)
  ok(target.protocol === 'https:', 'PUBLIC_QA_HTTPS_REQUIRED')
  const coldBudgetMs = options.coldBudgetMs ?? 12_000
  const warmBudgetMs = options.warmBudgetMs ?? 6_000
  const minimumFps = options.minimumFps ?? 24
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
  })

  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const pmtilesResponses: number[] = []
  let pmtilesRequests = 0
  let pmtilesWithoutRange = 0
  let pmtilesWithoutQuery = 0
  let pmtiles206 = 0
  let pmtilesContentRange = 0
  let pmtilesTransportMarker = 0
  let transferredBytes = 0

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await installFixtureGeolocation(page)
    await page.setRequestInterception(true)
    page.on('pageerror', (error) => pageErrors.push(sanitized(error instanceof Error ? error.message : 'PAGEERROR')))
    page.on('console', (message) => {
      if (message.type() !== 'error' || /favicon|styleimagemissing/i.test(message.text())) return
      consoleErrors.push(sanitized(message.text()))
    })
    page.on('request', (request: HTTPRequest) => {
      void (async () => {
        const url = new URL(request.url())
        const sameOrigin = url.origin === target.origin
        if (sameOrigin && url.pathname.endsWith('.pmtiles')) {
          pmtilesRequests += 1
          if (!request.headers().range) pmtilesWithoutRange += 1
          if (!url.searchParams.has('pmtilesOffset') || !url.searchParams.has('pmtilesLength')) pmtilesWithoutQuery += 1
        }
        await request.continue({ headers: sameOrigin ? { ...request.headers(), ...(options.requestHeaders || {}) } : request.headers() })
      })().catch(() => request.abort().catch(() => undefined))
    })
    page.on('response', (response) => {
      try {
        const url = new URL(response.url())
        if (url.origin !== target.origin || !url.pathname.endsWith('.pmtiles')) return
        const headers = response.headers()
        if (response.status() === 206) { pmtiles206 += 1; pmtilesResponses.push(Date.now()) }
        if (/^bytes \d+-\d+\/\d+$/.test(headers['content-range'] || '')) pmtilesContentRange += 1
        if (headers['x-stracker-pmtiles-transport'] === 'query-v1') pmtilesTransportMarker += 1
        const length = Number(headers['content-length'])
        if (Number.isFinite(length) && length > 0) transferredBytes += length
      } catch {}
    })

    const openMap = async (label: string, fixture: 'dense-central' | 'mixed-rise'): Promise<RunMetrics> => {
      const responseIndex = pmtilesResponses.length
      let rootReady = false
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const url = new URL(`/?dense3d=${label}-${Date.now()}-${attempt}&fixture=${fixture}`, target)
        const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => null)
        if (response?.status() === 200) {
          rootReady = await page.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'), { timeout: 25_000 })
            .then(() => true).catch(() => false)
        }
        if (rootReady) break
        if (attempt < 3) await Bun.sleep(3_000)
      }
      ok(rootReady, `PUBLIC_ROOT_NOT_READY_${label}`)
      await clickText(page, 'MI UBICACIÓN')
      const startedAt = Date.now()
      await clickText(page, 'PERMITIR UBICACIÓN')
      await page.waitForSelector('main[data-map-engine="maplibre"][data-location-source="my-device"]', { timeout: 30_000 })
      await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 30_000 })
      const responseDeadline = Date.now() + 90_000
      while (pmtilesResponses.length <= responseIndex && Date.now() < responseDeadline) await Bun.sleep(250)
      ok(pmtilesResponses.length > responseIndex, `PUBLIC_PMTILES_206_MISSING_${label}`)
      const stateDeadline = Date.now() + 90_000
      let state: RuntimeState | null = null
      while (Date.now() < stateDeadline) {
        state = await readState(page)
        if (customVisualRuntimeReady(state)) break
        await Bun.sleep(500)
      }
      ok(state && customVisualRuntimeReady(state), `PUBLIC_CUSTOM_3D_READINESS_TIMEOUT_${label}_${stateCode(state)}`)
      const readyMs = pmtilesResponses[responseIndex] - startedAt
      await Bun.sleep(1_000)
      state = await readState(page)
      ok(customVisualRuntimeReady(state), `PUBLIC_CUSTOM_3D_LOST_AFTER_READY_${label}_${stateCode(state)}`)
      return { readyMs, ...state }
    }

    const cold = await openMap('cold', 'dense-central')
    const canvas = await page.$('canvas.maplibregl-canvas')
    const clip = await canvas?.boundingBox()
    ok(clip, 'PUBLIC_MAP_CANVAS_MISSING')
    const onImage = await page.screenshot({ clip })
    const generation = cold.styleGeneration
    await page.click('button[aria-label="Activar o desactivar edificios 3D"]')
    await page.waitForFunction(() => document.querySelector('main[data-map-engine]')?.getAttribute('data-buildings-3d-state') === '3D_OFF', { timeout: 10_000 })
    await Bun.sleep(800)
    const offImage = await page.screenshot({ clip })
    const generationAfter = await page.$eval('main[data-map-engine]', (main) => Number(main.getAttribute('data-map-style-generation')))
    await page.click('button[aria-label="Activar o desactivar edificios 3D"]')
    const reenableDeadline = Date.now() + 30_000
    let reenabled: RuntimeState | null = null
    while (Date.now() < reenableDeadline) {
      reenabled = await readState(page)
      if (customVisualRuntimeReady(reenabled)) break
      await Bun.sleep(300)
    }
    ok(reenabled && customVisualRuntimeReady(reenabled), `PUBLIC_CUSTOM_3D_REENABLE_FAILED_${stateCode(reenabled)}`)

    const diff = await difference(onImage, offImage)
    const darkShare = await darkPixelShare(onImage)
    const fps = await measuredFps(page)
    const warm = await openMap('warm', 'mixed-rise')

    if (consoleErrors.length) console.error(`SANTA_FE_PUBLIC_QA_CONSOLE=${[...new Set(consoleErrors)].join(',')}`)
    ok(pageErrors.length === 0, 'PUBLIC_PAGEERROR_TOTAL')
    ok(consoleErrors.length === 0, 'PUBLIC_CONSOLE_ERROR_TOTAL')
    ok(pmtilesRequests > 0 && pmtilesWithoutRange === 0 && pmtilesWithoutQuery === 0, 'PUBLIC_PMTILES_REQUEST_CONTRACT')
    ok(pmtiles206 > 0 && pmtilesContentRange > 0 && pmtilesTransportMarker > 0, 'PUBLIC_PMTILES_RESPONSE_CONTRACT')
    ok(cold.readyMs > 0 && cold.readyMs <= coldBudgetMs, `PUBLIC_COLD_BUDGET_${cold.readyMs}`)
    ok(warm.readyMs > 0 && warm.readyMs <= warmBudgetMs, `PUBLIC_WARM_BUDGET_${warm.readyMs}`)
    ok(fps >= minimumFps, `PUBLIC_FPS_BUDGET_${fps}`)
    ok(generation === generationAfter, 'PUBLIC_THEME_OR_STYLE_CHANGED_DURING_BUILDING_TOGGLE')
    ok(cold.customLayerCount >= 4 && warm.customLayerCount >= 4, 'PUBLIC_CUSTOM_LAYER_COUNT_LOW')
    ok(cold.buildings3dState === '3D_ACTIVE' && warm.buildings3dState === '3D_ACTIVE', 'PUBLIC_CUSTOM_3D_NOT_ACTIVE')
    ok(!cold.genericFallbackVisible && !warm.genericFallbackVisible, 'PUBLIC_GENERIC_FALLBACK_STILL_VISIBLE')
    ok(diff.changedPixels >= 8_000 && diff.meanAbsoluteDelta >= 0.2, 'PUBLIC_BUILDING_ONLY_PIXEL_DIFF_TOO_LOW')
    ok(diff.verticalEdgePixels >= 100, 'PUBLIC_VERTICAL_EDGE_SIGNAL_TOO_LOW')
    ok(diff.roofSurfacePixels >= 500, 'PUBLIC_ROOF_SURFACE_SIGNAL_TOO_LOW')
    ok(diff.screenSpaceHeightBuckets >= 3, 'PUBLIC_SCREEN_SPACE_HEIGHT_BUCKETS_TOO_LOW')
    ok(darkShare < 0.42, 'PUBLIC_CITY_STYLE_TOO_DARK')

    await mkdir(options.screenshotDir, { recursive: true })
    const onName = `${options.screenshotPrefix}-on.png`
    const offName = `${options.screenshotPrefix}-off.png`
    const diffName = `${options.screenshotPrefix}-layer-only-diff.png`
    await Bun.write(join(options.screenshotDir, onName), onImage)
    await Bun.write(join(options.screenshotDir, offName), offImage)
    await Bun.write(join(options.screenshotDir, diffName), diff.image)

    return {
      schema: 'stracker.santa-fe-public-browser-qa.v4',
      viewport: '390x844',
      explicitSwiftShaderArgumentUsed: false,
      privateDataUsed: false,
      realUserCoordinatesUsed: false,
      coordinateValuesRetained: false,
      cold,
      warm,
      measuredFps: fps,
      buildingOnlyChangedPixels: diff.changedPixels,
      buildingOnlyMeanAbsoluteDelta: Math.round(diff.meanAbsoluteDelta * 10_000) / 10_000,
      verticalEdgePixels: diff.verticalEdgePixels,
      roofSurfacePixels: diff.roofSurfacePixels,
      screenSpaceHeightBuckets: diff.screenSpaceHeightBuckets,
      noThemeChangeDuringToggle: true,
      darkPixelShare: Math.round(darkShare * 1_000_000) / 1_000_000,
      pmtilesRequests,
      pmtilesWithoutRange,
      pmtilesWithoutQuery,
      pmtiles206,
      pmtilesContentRange,
      pmtilesTransportMarker,
      transferredBytes,
      pageErrorTotal: pageErrors.length,
      consoleErrorTotal: consoleErrors.length,
      screenshots: [
        { name: onName, sha256: digest(onImage) },
        { name: offName, sha256: digest(offImage) },
        { name: diffName, sha256: digest(diff.image) },
      ],
      gates: {
        PUBLIC_RUNTIME_ROOT_READY: 'PASS',
        PUBLIC_RUNTIME_MAP_MOUNTED: 'PASS',
        PUBLIC_RUNTIME_QUERY_RANGE_REQUESTS: 'PASS',
        PUBLIC_RUNTIME_PMTILES_206: 'PASS',
        PUBLIC_RUNTIME_CONTENT_RANGE: 'PASS',
        PUBLIC_RUNTIME_QUERY_TRANSPORT_MARKER: 'PASS',
        CUSTOM_PMTILES_LAYERS_ACTIVE_AT_PUBLIC_FIXTURE_A: 'PASS',
        CUSTOM_PMTILES_LAYERS_ACTIVE_AT_PUBLIC_FIXTURE_B: 'PASS',
        GENERIC_FALLBACK_HIDDEN_AT_BOTH_FIXTURES: 'PASS',
        CUSTOM_3D_VISUAL_DIFF_PROOF: 'PASS',
        BUILDING_ONLY_PIXEL_DIFF: 'PASS',
        VERTICAL_EDGE_SIGNAL: 'PASS',
        ROOF_SURFACE_SIGNAL: 'PASS',
        MULTIPLE_SCREEN_SPACE_HEIGHT_BUCKETS: 'PASS',
        NO_THEME_CHANGE_DURING_TOGGLE: 'PASS',
        PUBLIC_RUNTIME_LIGHT_CITY_STYLE: 'PASS',
        PUBLIC_RUNTIME_A22_COLD_BUDGET_SYNTHETIC: 'PASS',
        PUBLIC_RUNTIME_A22_WARM_BUDGET_SYNTHETIC: 'PASS',
        PUBLIC_RUNTIME_A22_FPS_BUDGET_SYNTHETIC: 'PASS',
        PUBLIC_RUNTIME_NO_PRIVATE_DATA: 'PASS',
      },
    }
  } finally {
    await browser.close()
  }
}
