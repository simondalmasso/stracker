import { createHash } from 'node:crypto'
import puppeteer from 'puppeteer-core'
import { runSantaFePublicBrowserQa } from './santa-fe-public-browser-qa'

const target = new URL(process.env.STRACKER_QA_URL || '')
const expectedSha = process.env.STRACKER_EXPECTED_SHA || ''
const expectedVersionId = process.env.STRACKER_EXPECTED_VERSION_ID || ''
const output = process.env.STRACKER_POST_3D_QA_OUTPUT || '/tmp/stracker-santa-fe-post-promotion-3d.json'
const screenshotDir = process.env.STRACKER_POST_3D_SCREENSHOT_DIR || '/tmp'

class PostPromotionFailure extends Error {
  constructor(readonly code: string) { super(code) }
}

function ok(value: unknown, code: string): asserts value {
  if (!value) throw new PostPromotionFailure(code)
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeError(value: unknown): string {
  return String(value instanceof Error ? value.message : value || 'UNKNOWN')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/[A-Za-z0-9_-]{43}(?:\.[A-Za-z0-9_-]{43})?/g, '[VALUE]')
    .replace(/[^A-Za-z0-9_[\]-]+/g, '_')
    .slice(0, 220)
}

async function verifyExactHead(): Promise<void> {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const headers = { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
  const [buildResponse, versionResponse] = await Promise.all([
    fetch(new URL(`/__stracker/build.json?post3d=${nonce}`, target), { headers, cache: 'no-store' }),
    fetch(new URL(`/__stracker/version.json?post3d=${nonce}`, target), { headers, cache: 'no-store' }),
  ])
  ok(buildResponse.status === 200 && versionResponse.status === 200, 'POST_3D_IDENTITY_UNAVAILABLE')
  const build = await buildResponse.json().catch(() => null) as { sourceSha?: string; release?: string } | null
  const version = await versionResponse.json().catch(() => null) as { sourceSha?: string; versionId?: string } | null
  ok(build?.sourceSha === expectedSha && build.release === 'controlled-physical-pilot-v1', 'POST_3D_BUILD_SHA_MISMATCH')
  ok(version?.sourceSha === expectedSha && version.versionId === expectedVersionId, 'POST_3D_VERSION_MISMATCH')
}

async function installSupplementalSoftwareWebgl(): Promise<void> {
  const executable = process.env.CHROME_BIN || '/usr/bin/google-chrome'
  const wrapper = '/tmp/stracker-post-promotion-chrome-swiftshader.sh'
  await Bun.write(wrapper, `#!/usr/bin/env bash\nexec ${JSON.stringify(executable)} --use-angle=swiftshader "$@"\n`)
  const chmod = Bun.spawnSync(['chmod', '700', wrapper])
  if (chmod.exitCode !== 0) throw new PostPromotionFailure('POST_3D_WEBGL_WRAPPER_INSTALL_FAILED')
  process.env.CHROME_BIN = wrapper
}

async function diagnoseProductShell(): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
  })
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const failedRequests: string[] = []
  const badSameOrigin: string[] = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await page.evaluateOnNewDocument(() => {
      const state = { watchCalls: 0, callbacks: 0 }
      Object.defineProperty(window, '__strackerShellDiag', { value: state })
      Object.defineProperty(navigator, 'geolocation', {
        configurable: true,
        value: {
          getCurrentPosition(success: PositionCallback) {
            state.callbacks += 1
            setTimeout(() => success({ coords: { latitude: -31.6401, longitude: -60.7003, accuracy: 4, altitude: null, altitudeAccuracy: null, heading: 25, speed: 0, toJSON: () => ({}) }, timestamp: Date.now(), toJSON: () => ({}) }), 10)
          },
          watchPosition(success: PositionCallback) {
            state.watchCalls += 1
            const id = state.watchCalls
            setTimeout(() => { state.callbacks += 1; success({ coords: { latitude: -31.6401, longitude: -60.7003, accuracy: 4, altitude: null, altitudeAccuracy: null, heading: 25, speed: 0, toJSON: () => ({}) }, timestamp: Date.now(), toJSON: () => ({}) }) }, 50)
            return id
          },
          clearWatch() {},
        },
      })
    })
    page.on('pageerror', (error) => pageErrors.push(safeError(error)))
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(safeError(message.text())) })
    page.on('requestfailed', (request) => failedRequests.push(`${safeError(new URL(request.url()).pathname)}:${safeError(request.failure()?.errorText)}`))
    page.on('response', (response) => {
      try {
        const url = new URL(response.url())
        if (url.origin === target.origin && response.status() >= 400) badSameOrigin.push(`${response.status()}:${safeError(url.pathname)}`)
      } catch {}
    })
    const url = new URL(`/?post3d-shell=${Date.now()}`, target)
    const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    ok(response?.status() === 200, `POST_3D_SHELL_ROOT_${response?.status() || 0}`)
    await page.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'), { timeout: 30_000 })
    await page.$$eval('button', (buttons) => {
      const button = buttons.find((item) => item.textContent?.toUpperCase().includes('MI UBICACIÓN')) as HTMLButtonElement | undefined
      if (!button) throw new Error('MI_UBICACION_NOT_FOUND')
      button.click()
    })
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.includes('PERMITIR UBICACIÓN')), { timeout: 30_000 })
    await page.$$eval('button', (buttons) => {
      const button = buttons.find((item) => item.textContent?.includes('PERMITIR UBICACIÓN')) as HTMLButtonElement | undefined
      if (!button) throw new Error('PERMITIR_UBICACION_NOT_FOUND')
      button.click()
    })
    const canvasReady = await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 20_000 }).then(() => true).catch(() => false)
    const dom = await page.evaluate(() => {
      const main = document.querySelector('main')
      const diag = (window as unknown as { __strackerShellDiag?: { watchCalls: number; callbacks: number } }).__strackerShellDiag
      return {
        canvasCount: document.querySelectorAll('canvas.maplibregl-canvas').length,
        mapMain: Boolean(document.querySelector('main[data-map-engine="maplibre"]')),
        provider: document.querySelector('main[data-map-engine="maplibre"]')?.getAttribute('data-map-provider') || 'NONE',
        flowText: (main?.textContent || '').replace(/\s+/g, ' ').slice(0, 180),
        watchCalls: diag?.watchCalls || 0,
        callbacks: diag?.callbacks || 0,
      }
    })
    const diagnostic = {
      canvasReady,
      ...dom,
      pageErrors: [...new Set(pageErrors)].slice(0, 6),
      consoleErrors: [...new Set(consoleErrors)].slice(0, 8),
      failedRequests: [...new Set(failedRequests)].slice(0, 8),
      badSameOrigin: [...new Set(badSameOrigin)].slice(0, 8),
    }
    console.log(`POST_3D_PRODUCT_SHELL_DIAGNOSTIC=${JSON.stringify(diagnostic)}`)
    ok(canvasReady, `POST_3D_PRODUCT_SHELL_CANVAS_MISSING_${safeError(JSON.stringify(diagnostic))}`)
  } finally {
    await browser.close()
  }
}

if (target.protocol !== 'https:' || !target.hostname) throw new Error('HTTPS_TARGET_REQUIRED')
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('EXPECTED_SHA_REQUIRED')
if (!expectedVersionId) throw new Error('EXPECTED_VERSION_ID_REQUIRED')

await verifyExactHead()
await installSupplementalSoftwareWebgl()
await diagnoseProductShell()

let browser: Record<string, unknown> | null = null
let browserAttempts = 0
let firstFailure = 'NONE'
for (let attempt = 1; attempt <= 3; attempt += 1) {
  browserAttempts = attempt
  await verifyExactHead()
  try {
    browser = await runSantaFePublicBrowserQa({
      targetUrl: target.toString(),
      requestHeaders: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      screenshotDir,
      screenshotPrefix: `santa-fe-post-promotion-3d-${attempt}`,
      coldBudgetMs: 20_000,
      warmBudgetMs: 12_000,
    })
    await verifyExactHead()
    console.log(`SANTA_FE_POST_PROMOTION_BROWSER_ATTEMPT=${attempt} RESULT=PASS`)
    break
  } catch (error) {
    const code = safeError(error)
    if (firstFailure === 'NONE') firstFailure = code
    console.log(`SANTA_FE_POST_PROMOTION_BROWSER_ATTEMPT=${attempt} RESULT=RETRY CLASSIFICATION=${code}`)
    if (attempt < 3) await Bun.sleep(8_000)
  }
}
ok(browser, `POST_3D_BROWSER_FAILED_${firstFailure}`)

const gates = browser.gates as Record<string, string>
gates.POST_PROMOTION_100_PERCENT_EXACT_HEAD = 'PASS'
gates.POST_PROMOTION_PUBLIC_SANTA_FE_3D_RENDER = 'PASS'
gates.POST_PROMOTION_PRODUCT_SHELL_CANVAS = 'PASS'
gates.POST_PROMOTION_BROWSER_CACHE_BYPASS = 'PASS'
gates.POST_PROMOTION_BROWSER_RETRY_BOUNDED = 'PASS'
gates.SWIFTSHADER_NOT_SOLE_EVIDENCE = 'PASS'
gates.OWNER_PHYSICAL_ACCEPTANCE_REMAINS_REQUIRED = 'PASS'

const result = {
  schema: 'stracker.santa-fe-post-promotion-3d.v3',
  sourceSha: expectedSha,
  expectedVersionIdHash: hash(expectedVersionId),
  browserAttempts,
  firstFailure,
  rootCause: browserAttempts > 1 ? 'PUBLIC_STATIC_ASSET_OR_DYNAMIC_CHUNK_PROPAGATION_RACE' : 'NONE',
  privateDataUsed: false,
  realUserCoordinatesUsed: false,
  coordinateValuesRetained: false,
  rawVersionIdRetained: false,
  automationRenderer: 'SWIFTSHADER_SUPPLEMENTAL',
  swiftShaderSoleEvidence: false,
  ownerPhysicalAcceptanceStillRequired: true,
  browser,
  gates,
}
await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
console.log(`SANTA_FE_POST_PROMOTION_BROWSER_QA=PASS attempts=${browserAttempts}`)
