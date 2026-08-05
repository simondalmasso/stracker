import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import sharp from 'sharp'
import manifest from '../../public/data/santa-fe-3d/manifest.json'

const target = new URL(process.env.STRACKER_QA_URL || '')
const expectedSha = process.env.STRACKER_EXPECTED_SHA || ''
const candidateVersion = process.env.STRACKER_EXPECTED_VERSION_ID || ''
const workerName = process.env.STRACKER_PUBLIC_WORKER || 'stracker'
const chrome = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const output = process.env.STRACKER_AFFINITY_QA_OUTPUT || '/tmp/stracker-santa-fe-affinity-canary.json'
const screenshotDir = process.env.STRACKER_AFFINITY_SCREENSHOT_DIR || '/tmp'
const fixture = { lat: -31.6401, lng: -60.7003 }

class QaFailure extends Error {
  constructor(readonly code: string) { super(code) }
}
function ok(value: unknown, code: string): asserts value {
  if (!value) throw new QaFailure(code)
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
function candidateHeaders(key: string): Record<string, string> {
  return {
    'Cloudflare-Workers-Version-Key': key,
    'Cloudflare-Workers-Version-Overrides': `${workerName}="${candidateVersion}"`,
    'Cache-Control': 'no-cache',
  }
}

async function findCandidateAffinityKey(): Promise<string> {
  const batchSize = 64
  const maxKeys = 2048
  for (let start = 0; start < maxKeys; start += batchSize) {
    const candidates = Array.from({ length: batchSize }, (_, index) => `sf3d-${expectedSha.slice(0, 12)}-${start + index}`)
    const observations = await Promise.all(candidates.map(async (key) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      try {
        const response = await fetch(new URL(`/__stracker/version.json?affinity=${start}-${Math.random().toString(36).slice(2)}`, target), {
          headers: { 'Cloudflare-Workers-Version-Key': key, Accept: 'application/json', 'Cache-Control': 'no-cache' },
          cache: 'no-store',
          signal: controller.signal,
        })
        const payload = await response.json().catch(() => null) as { versionId?: string; sourceSha?: string } | null
        return response.status === 200 && payload?.versionId === candidateVersion && payload?.sourceSha === expectedSha ? key : null
      } catch {
        return null
      } finally {
        clearTimeout(timeout)
      }
    }))
    const match = observations.find((value): value is string => Boolean(value))
    if (match) return match
    await Bun.sleep(150)
  }
  throw new QaFailure('AFFINITY_KEY_FOR_CANDIDATE_NOT_FOUND')
}

async function waitForCandidateAssets(key: string): Promise<{ attempts: number; rangeResponses: number; transferredBytes: number }> {
  const headers = candidateHeaders(key)
  let last = 'MANIFEST_UNAVAILABLE'
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const nonce = `${Date.now()}-${attempt}-${Math.random().toString(36).slice(2)}`
    try {
      const response = await fetch(new URL(`/data/santa-fe-3d/manifest.json?affinity=${nonce}`, target), {
        headers,
        cache: 'no-store',
      })
      if (response.status !== 200) {
        last = `MANIFEST_HTTP_${response.status}`
      } else {
        const remote = await response.json().catch(() => null) as typeof manifest | null
        const matches = Boolean(
          remote
          && remote.final_features === manifest.final_features
          && remote.unique_height_bucket_count === manifest.unique_height_bucket_count
          && remote.uniform_default_height_fraction === manifest.uniform_default_height_fraction
          && JSON.stringify(remote.asset_paths) === JSON.stringify(manifest.asset_paths),
        )
        if (!matches) {
          last = 'MANIFEST_CONTRACT_MISMATCH'
        } else {
          let transferredBytes = 0
          let rangeResponses = 0
          let allReady = true
          for (const path of manifest.asset_paths) {
            const range = await fetch(new URL(path, target), {
              headers: { ...headers, Range: 'bytes=0-16383', 'Accept-Encoding': 'identity' },
              cache: 'no-store',
            })
            const body = await range.arrayBuffer()
            const contentRange = range.headers.get('content-range') || ''
            const valid = range.status === 206
              && range.headers.get('accept-ranges')?.toLowerCase() === 'bytes'
              && /^bytes 0-\d+\/\d+$/.test(contentRange)
              && body.byteLength > 0
              && body.byteLength <= 16_384
            if (!valid) {
              last = `RANGE_HTTP_${range.status}`
              allReady = false
              break
            }
            rangeResponses += 1
            transferredBytes += body.byteLength
          }
          if (allReady) return { attempts: attempt, rangeResponses, transferredBytes }
        }
      }
    } catch {
      last = 'NETWORK_OR_PARSE_FAILURE'
    }
    if (attempt < 30) await Bun.sleep(2_000)
  }
  throw new QaFailure(`CANDIDATE_STATIC_ASSET_TIMEOUT_${last}`)
}

async function installPublicFixtureGeolocation(page: import('puppeteer-core').Page): Promise<void> {
  await page.evaluateOnNewDocument((point) => {
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
  }, fixture)
}

async function clickText(page: import('puppeteer-core').Page, text: string): Promise<void> {
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

async function runBrowserCandidateQa(key: string): Promise<Record<string, unknown>> {
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await installPublicFixtureGeolocation(page)
    await page.setRequestInterception(true)
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    let pmtilesRequests = 0
    let pmtilesWithoutRange = 0
    let pmtiles206 = 0
    let pmtilesContentRange = 0
    page.on('pageerror', (error) => pageErrors.push(sanitized(error instanceof Error ? error.message : 'PAGEERROR')))
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(sanitized(message.text())) })
    page.on('request', (request) => {
      void (async () => {
        const url = new URL(request.url())
        const sameOrigin = url.origin === target.origin
        if (sameOrigin && url.pathname.endsWith('.pmtiles')) {
          pmtilesRequests += 1
          if (!request.headers().range) pmtilesWithoutRange += 1
        }
        const headers = sameOrigin ? { ...request.headers(), ...candidateHeaders(key) } : request.headers()
        await request.continue({ headers })
      })().catch(() => request.abort().catch(() => undefined))
    })
    page.on('response', (response) => {
      try {
        const url = new URL(response.url())
        if (url.origin === target.origin && url.pathname.endsWith('.pmtiles')) {
          if (response.status() === 206) pmtiles206 += 1
          if (/^bytes \d+-\d+\/\d+$/.test(response.headers()['content-range'] || '')) pmtilesContentRange += 1
        }
      } catch {}
    })

    const openMap = async (label: string): Promise<{ firstInteractiveMs: number; estimatedFps: number }> => {
      const response = await page.goto(new URL(`/?affinity=${label}-${Date.now()}`, target).href, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      ok(response?.status() === 200, `ROOT_HTTP_${response?.status() || 'NONE'}`)
      await page.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'), { timeout: 45_000 })
      await clickText(page, 'MI UBICACIÓN')
      await clickText(page, 'PERMITIR UBICACIÓN')
      await page.waitForSelector('main[data-map-engine="maplibre"][data-location-source="my-device"][data-map-provider="available"]', { timeout: 90_000 })
      const deadline = Date.now() + 90_000
      while (pmtiles206 === 0 && Date.now() < deadline) await Bun.sleep(500)
      ok(pmtiles206 > 0, 'BROWSER_PMTILES_206_MISSING')
      await Bun.sleep(5_500)
      return page.evaluate(() => {
        const main = document.querySelector('main[data-map-engine="maplibre"]')
        return {
          firstInteractiveMs: Number(main?.getAttribute('data-map-first-interactive-ms')) || 0,
          estimatedFps: Number(main?.getAttribute('data-map-fps')) || 0,
        }
      })
    }

    const cold = await openMap('cold')
    const canvas = await page.$('canvas.maplibregl-canvas')
    const clip = await canvas?.boundingBox()
    ok(clip, 'MAP_CANVAS_MISSING')
    const onImage = await page.screenshot({ clip })
    await page.click('button[aria-label="Activar o desactivar edificios 3D"]')
    await Bun.sleep(1_200)
    const offImage = await page.screenshot({ clip })
    await page.click('button[aria-label="Activar o desactivar edificios 3D"]')
    await Bun.sleep(2_000)
    const difference = await imageDifference(onImage, offImage)
    const light = await lightStyleStats(onImage)

    const warm = await openMap('warm')
    ok(cold.firstInteractiveMs > 0 && cold.firstInteractiveMs <= 12_000, `COLD_INTERACTIVE_BUDGET_${cold.firstInteractiveMs}`)
    ok(warm.firstInteractiveMs > 0 && warm.firstInteractiveMs <= 6_000, `WARM_INTERACTIVE_BUDGET_${warm.firstInteractiveMs}`)
    ok(cold.estimatedFps >= 24 && warm.estimatedFps >= 24, `FPS_BUDGET_${cold.estimatedFps}_${warm.estimatedFps}`)
    ok(difference.changedPixels >= 8_000 && difference.meanAbsoluteDelta >= 0.35, 'VISIBLE_3D_EFFECT_TOO_LOW')
    ok(light.darkPixelShare < 0.42, 'CITY_STYLE_TOO_DARK')
    ok(pageErrors.length === 0, 'PAGEERROR_TOTAL')
    if (consoleErrors.length) console.error(`AFFINITY_CANARY_CONSOLE=${consoleErrors.join(',')}`)
    ok(consoleErrors.length === 0, 'CONSOLE_ERROR_TOTAL')
    ok(pmtilesRequests > 0 && pmtilesWithoutRange === 0, 'FULL_PMTILES_BROWSER_REQUEST')
    ok(pmtiles206 > 0 && pmtilesContentRange > 0, 'BROWSER_RANGE_HEADERS_MISSING')

    await mkdir(screenshotDir, { recursive: true })
    const onName = 'santa-fe-affinity-canary-on.png'
    const offName = 'santa-fe-affinity-canary-off.png'
    await Bun.write(join(screenshotDir, onName), onImage)
    await Bun.write(join(screenshotDir, offName), offImage)
    return {
      viewport: '390x844',
      coldFirstInteractiveMs: cold.firstInteractiveMs,
      warmFirstInteractiveMs: warm.firstInteractiveMs,
      coldEstimatedFps: cold.estimatedFps,
      warmEstimatedFps: warm.estimatedFps,
      changedPixels: difference.changedPixels,
      meanAbsoluteDelta: Math.round(difference.meanAbsoluteDelta * 10_000) / 10_000,
      darkPixelShare: Math.round(light.darkPixelShare * 1_000_000) / 1_000_000,
      pmtilesRequests,
      pmtilesWithoutRange,
      pmtiles206,
      pmtilesContentRange,
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
if (!candidateVersion) throw new Error('EXPECTED_VERSION_ID_REQUIRED')

const affinityKey = await findCandidateAffinityKey()
const staticAssets = await waitForCandidateAssets(affinityKey)
const browser = await runBrowserCandidateQa(affinityKey)
const result = {
  schema: 'stracker.santa-fe-affinity-canary.v1',
  sourceSha: expectedSha,
  candidateVersionHash: digest(Buffer.from(candidateVersion)),
  affinityKeyHash: digest(Buffer.from(affinityKey)),
  privateDataUsed: false,
  realUserCoordinatesUsed: false,
  coordinateValuesRetained: false,
  staticAssets,
  browser,
  gates: {
    ONE_PERCENT_VERSION_AFFINITY: 'PASS',
    CANDIDATE_BUILD_AND_VERSION_IDENTITY: 'PASS',
    CANDIDATE_MANIFEST_EXACT: 'PASS',
    CANDIDATE_PMTILES_RANGE_206: 'PASS',
    CANDIDATE_CONTENT_RANGE: 'PASS',
    CANDIDATE_BROWSER_DENSE_SANTA_FE_3D: 'PASS',
    CANDIDATE_BROWSER_LIGHT_CITY_STYLE: 'PASS',
    CANDIDATE_BROWSER_BUILDING_TOGGLE: 'PASS',
    CANDIDATE_A22_COLD_BUDGET_SYNTHETIC: 'PASS',
    CANDIDATE_A22_WARM_BUDGET_SYNTHETIC: 'PASS',
    CANDIDATE_A22_FPS_BUDGET_SYNTHETIC: 'PASS',
    NO_PRIVATE_DATA_IN_CANARY: 'PASS',
  },
}
await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
console.log('SANTA_FE_AFFINITY_CANARY_QA=PASS')
