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

interface RunMetrics {
  readyMs: number
  providerState: string
  firstVisibleMs: number | null
  firstInteractiveMs: number | null
  estimatedFpsAttribute: number | null
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

function sanitize(value: unknown): string {
  return String(value || 'UNKNOWN')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/[A-Za-z0-9_-]{43}(?:\.[A-Za-z0-9_-]{43})?/g, '[CAPABILITY]')
    .replace(/[^A-Z0-9_[\]-]+/gi, '_')
    .slice(0, 160)
}

async function installFixtureGeolocation(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const point = { lat: -31.6401, lng: -60.7003 }
    let nextId = 1
    const active = new Map<number, PositionCallback>()
    const position = (): GeolocationPosition => ({
      coords: {
        latitude: point.lat,
        longitude: point.lng,
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
        watchPosition(success: PositionCallback) {
          const id = nextId++
          active.set(id, success)
          setTimeout(() => { if (active.has(id)) success(position()) }, 50)
          return id
        },
        clearWatch(id: number) { active.delete(id) },
      },
    })
  })
}

async function clickText(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (value) => [...document.querySelectorAll('button')].some((button) => button.textContent?.toUpperCase().includes(String(value).toUpperCase())),
    { timeout: 30_000 },
    text,
  )
  await page.$$eval('button', (buttons, value) => {
    const button = buttons.find((candidate) => candidate.textContent?.toUpperCase().includes(String(value).toUpperCase()))
    if (!(button instanceof HTMLButtonElement)) throw new Error('BUTTON_NOT_FOUND')
    button.click()
  }, text)
}

async function imageDifference(a: Uint8Array, b: Uint8Array): Promise<{ changedPixels: number; meanAbsoluteDelta: number }> {
  const [left, right] = await Promise.all([
    sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ])
  ok(left.info.width === right.info.width && left.info.height === right.info.height, 'SCREENSHOT_DIMENSION_MISMATCH')
  let changedPixels = 0
  let totalDelta = 0
  for (let index = 0; index < left.data.length; index += left.info.channels) {
    const delta = Math.abs(left.data[index] - right.data[index])
      + Math.abs(left.data[index + 1] - right.data[index + 1])
      + Math.abs(left.data[index + 2] - right.data[index + 2])
    totalDelta += delta
    if (delta >= 18) changedPixels += 1
  }
  return {
    changedPixels,
    meanAbsoluteDelta: totalDelta / Math.max(1, left.info.width * left.info.height * 3),
  }
}

async function lightStyleStats(image: Uint8Array): Promise<{ darkPixelShare: number }> {
  const raster = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let dark = 0
  for (let index = 0; index < raster.data.length; index += raster.info.channels) {
    if (raster.data[index] < 48 && raster.data[index + 1] < 48 && raster.data[index + 2] < 48) dark += 1
  }
  return { darkPixelShare: dark / Math.max(1, raster.info.width * raster.info.height) }
}

async function measuredFps(page: Page): Promise<number> {
  return page.evaluate(async () => {
    let frames = 0
    const start = performance.now()
    await new Promise<void>((resolve) => {
      const frame = () => {
        frames += 1
        if (performance.now() - start >= 2_000) resolve()
        else requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
    return Math.round((frames * 1_000) / Math.max(1, performance.now() - start))
  })
}

export async function runSantaFePublicBrowserQa(options: SantaFePublicBrowserQaOptions): Promise<Record<string, unknown>> {
  const target = new URL(options.targetUrl)
  ok(target.protocol === 'https:', 'PUBLIC_QA_HTTPS_REQUIRED')
  const coldBudgetMs = options.coldBudgetMs ?? 12_000
  const warmBudgetMs = options.warmBudgetMs ?? 6_000
  const minimumFps = options.minimumFps ?? 24
  const requestHeaders = options.requestHeaders || {}
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  })

  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const pmtilesResponseTimes: number[] = []
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
    page.on('pageerror', (error) => pageErrors.push(sanitize(error instanceof Error ? error.message : 'PAGEERROR')))
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const text = message.text()
      if (/favicon|styleimagemissing/i.test(text)) return
      consoleErrors.push(sanitize(text))
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
        const headers = sameOrigin ? { ...request.headers(), ...requestHeaders } : request.headers()
        await request.continue({ headers })
      })().catch(() => request.abort().catch(() => undefined))
    })
    page.on('response', (response) => {
      try {
        const url = new URL(response.url())
        if (url.origin !== target.origin || !url.pathname.endsWith('.pmtiles')) return
        if (response.status() === 206) {
          pmtiles206 += 1
          pmtilesResponseTimes.push(Date.now())
        }
        const headers = response.headers()
        if (/^bytes \d+-\d+\/\d+$/.test(headers['content-range'] || '')) pmtilesContentRange += 1
        if (headers['x-stracker-pmtiles-transport'] === 'query-v1') pmtilesTransportMarker += 1
        const length = Number(headers['content-length'])
        if (Number.isFinite(length) && length > 0) transferredBytes += length
      } catch {}
    })

    const openMap = async (label: string): Promise<RunMetrics> => {
      const beforeResponses = pmtilesResponseTimes.length
      let rootReady = false
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const response = await page.goto(new URL(`/?dense3d=${label}-${Date.now()}-${attempt}`, target).href, {
          waitUntil: 'domcontentloaded',
          timeout: 60_000,
        }).catch(() => null)
        if (response?.status() === 200) {
          rootReady = await page.waitForFunction(
            () => document.body.textContent?.includes('¿Qué ubicación querés ver?'),
            { timeout: 25_000 },
          ).then(() => true).catch(() => false)
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
      const deadline = Date.now() + 90_000
      while (pmtilesResponseTimes.length <= beforeResponses && Date.now() < deadline) await Bun.sleep(250)
      ok(pmtilesResponseTimes.length > beforeResponses, `PUBLIC_PMTILES_206_MISSING_${label}`)
      const readyMs = pmtilesResponseTimes[beforeResponses] - startedAt
      await Bun.sleep(4_500)
      const state = await page.evaluate(() => {
        const main = document.querySelector('main[data-map-engine="maplibre"]')
        const number = (name: string): number | null => {
          const value = Number(main?.getAttribute(name))
          return Number.isFinite(value) && value > 0 ? value : null
        }
        return {
          providerState: main?.getAttribute('data-map-provider') || 'missing',
          firstVisibleMs: number('data-map-first-visible-ms'),
          firstInteractiveMs: number('data-map-first-interactive-ms'),
          estimatedFpsAttribute: number('data-map-fps'),
        }
      })
      ok(state.providerState !== 'degraded' && state.providerState !== 'missing', `PUBLIC_MAP_PROVIDER_${state.providerState}_${label}`)
      return { readyMs, ...state }
    }

    const cold = await openMap('cold')
    const canvas = await page.$('canvas.maplibregl-canvas')
    const clip = await canvas?.boundingBox()
    ok(clip, 'PUBLIC_MAP_CANVAS_MISSING')
    const onImage = await page.screenshot({ clip })
    await page.click('button[aria-label="Activar o desactivar edificios 3D"]')
    await Bun.sleep(1_200)
    const offImage = await page.screenshot({ clip })
    await page.click('button[aria-label="Activar o desactivar edificios 3D"]')
    await Bun.sleep(2_000)
    const difference = await imageDifference(onImage, offImage)
    const light = await lightStyleStats(onImage)
    const fps = await measuredFps(page)
    const warm = await openMap('warm')

    if (consoleErrors.length) console.error(`SANTA_FE_PUBLIC_QA_CONSOLE=${[...new Set(consoleErrors)].join(',')}`)
    ok(pageErrors.length === 0, 'PUBLIC_PAGEERROR_TOTAL')
    ok(consoleErrors.length === 0, 'PUBLIC_CONSOLE_ERROR_TOTAL')
    ok(pmtilesRequests > 0 && pmtilesWithoutRange === 0 && pmtilesWithoutQuery === 0, 'PUBLIC_PMTILES_REQUEST_CONTRACT')
    ok(pmtiles206 > 0 && pmtilesContentRange > 0 && pmtilesTransportMarker > 0, 'PUBLIC_PMTILES_RESPONSE_CONTRACT')
    ok(cold.readyMs > 0 && cold.readyMs <= coldBudgetMs, `PUBLIC_COLD_BUDGET_${cold.readyMs}`)
    ok(warm.readyMs > 0 && warm.readyMs <= warmBudgetMs, `PUBLIC_WARM_BUDGET_${warm.readyMs}`)
    ok(fps >= minimumFps, `PUBLIC_FPS_BUDGET_${fps}`)
    ok(difference.changedPixels >= 8_000 && difference.meanAbsoluteDelta >= 0.35, 'PUBLIC_VISIBLE_3D_EFFECT_TOO_LOW')
    ok(light.darkPixelShare < 0.42, 'PUBLIC_CITY_STYLE_TOO_DARK')

    await mkdir(options.screenshotDir, { recursive: true })
    const onName = `${options.screenshotPrefix}-on.png`
    const offName = `${options.screenshotPrefix}-off.png`
    await Bun.write(join(options.screenshotDir, onName), onImage)
    await Bun.write(join(options.screenshotDir, offName), offImage)
    return {
      schema: 'stracker.santa-fe-public-browser-qa.v1',
      viewport: '390x844',
      privateDataUsed: false,
      realUserCoordinatesUsed: false,
      coordinateValuesRetained: false,
      cold,
      warm,
      measuredFps: fps,
      changedPixels: difference.changedPixels,
      meanAbsoluteDelta: Math.round(difference.meanAbsoluteDelta * 10_000) / 10_000,
      darkPixelShare: Math.round(light.darkPixelShare * 1_000_000) / 1_000_000,
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
      ],
      gates: {
        PUBLIC_RUNTIME_ROOT_READY: 'PASS',
        PUBLIC_RUNTIME_MAP_MOUNTED: 'PASS',
        PUBLIC_RUNTIME_QUERY_RANGE_REQUESTS: 'PASS',
        PUBLIC_RUNTIME_PMTILES_206: 'PASS',
        PUBLIC_RUNTIME_CONTENT_RANGE: 'PASS',
        PUBLIC_RUNTIME_QUERY_TRANSPORT_MARKER: 'PASS',
        PUBLIC_RUNTIME_DENSE_SANTA_FE_3D: 'PASS',
        PUBLIC_RUNTIME_LIGHT_CITY_STYLE: 'PASS',
        PUBLIC_RUNTIME_BUILDING_TOGGLE_VISIBLE_EFFECT: 'PASS',
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
