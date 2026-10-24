import puppeteer, { type Browser, type ConsoleMessage, type HTTPRequest, type Page } from 'puppeteer-core'

const target = new URL(process.env.STRACKER_QA_URL || '')
const expectedSha = process.env.STRACKER_EXPECTED_SHA || ''
const expectedVersionId = process.env.STRACKER_EXPECTED_VERSION_ID || ''
const overrideVersion = process.env.STRACKER_VERSION_OVERRIDE || ''
const chrome = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const output = process.env.STRACKER_PILOT_QA_OUTPUT || '/tmp/stracker-controlled-pilot-live-qa.json'

if (target.protocol !== 'https:' || !target.hostname) throw new Error('HTTPS_TARGET_REQUIRED')
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('EXPECTED_SHA_REQUIRED')
if (!expectedVersionId) throw new Error('EXPECTED_VERSION_ID_REQUIRED')

class QaFailure extends Error {
  constructor(readonly code: string) { super(code) }
}
function ok(value: unknown, code: string): asserts value { if (!value) throw new QaFailure(code) }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Observation { method: string; path: string; sequence: number | null; api: boolean }
interface FakeStats { wakeRequests: number; wakeReleases: number; wakeHeld: boolean; clipboard: string }

function overrideHeaders(headers: Record<string, string>): Record<string, string> {
  return overrideVersion
    ? { ...headers, 'Cloudflare-Workers-Version-Overrides': `stracker="${overrideVersion}"` }
    : headers
}

async function fetchTarget(path: string): Promise<Response> {
  return fetch(new URL(path, target), {
    cache: 'no-store',
    headers: overrideHeaders({ Accept: 'application/json', 'Cache-Control': 'no-cache' }),
    redirect: 'error',
  })
}

async function click(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (value: string) => Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.toUpperCase().includes(value.toUpperCase())),
    {},
    text,
  )
  await page.$$eval('button', (buttons: Element[], value: string) => {
    const button = (buttons as HTMLButtonElement[]).find((candidate) => candidate.textContent?.toUpperCase().includes(value.toUpperCase()))
    if (!button) throw new Error('BUTTON_NOT_FOUND')
    button.click()
  }, text)
}

async function installFakes(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    let online = true
    let visibility = 'visible'
    let clockOffset = 0
    let clipboard = ''
    let watchId = 0
    let wakeRequests = 0
    let wakeReleases = 0
    let wakeHeld = false
    const watchers = new Map<number, PositionCallback>()
    const nativeNow = Date.now.bind(Date)
    Date.now = () => nativeNow() + clockOffset
    const point = (): GeolocationPosition => ({
      coords: {
        latitude: 10.1234,
        longitude: 20.5678,
        accuracy: 12,
        altitude: null,
        altitudeAccuracy: null,
        heading: 10,
        speed: 1,
        toJSON: () => ({}),
      },
      timestamp: nativeNow(),
      toJSON: () => ({}),
    })
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => ({ state: 'granted' }) } })
    Object.defineProperty(navigator, 'share', { configurable: true, value: async () => undefined })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { clipboard = String(value) } } })
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async () => {
          wakeRequests += 1
          wakeHeld = true
          const listeners: Array<() => void> = []
          const sentinel = {
            released: false,
            async release() {
              if (sentinel.released) return
              sentinel.released = true
              wakeHeld = false
              wakeReleases += 1
              for (const listener of listeners) listener()
            },
            addEventListener(type: string, listener: () => void) { if (type === 'release') listeners.push(listener) },
          }
          return sentinel
        },
      },
    })
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success: PositionCallback) { setTimeout(() => success(point()), 0) },
        watchPosition(success: PositionCallback) { const id = ++watchId; watchers.set(id, success); return id },
        clearWatch(id: number) { watchers.delete(id) },
      },
    })
    Object.defineProperty(window, '__pilotQA', {
      value: {
        setOnline(value: boolean) { online = value; window.dispatchEvent(new Event(value ? 'online' : 'offline')) },
        setVisibility(value: string) { visibility = value; document.dispatchEvent(new Event('visibilitychange')) },
        setClockOffset(value: number) { clockOffset = value },
        emitPoint() { for (const callback of watchers.values()) callback(point()) },
        stats: () => ({ wakeRequests, wakeReleases, wakeHeld, clipboard }),
      },
    })
  })
}

async function configure(
  page: Page,
  viewport: { width: number; height: number; deviceScaleFactor: number; isMobile: boolean; hasTouch: boolean },
  observations: Observation[],
  pageErrors: string[],
  consoleErrors: string[],
  expectedRevocation: { value: boolean },
): Promise<void> {
  await page.setViewport(viewport)
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await installFakes(page)
  await page.setRequestInterception(true)
  page.on('pageerror', () => pageErrors.push('PAGEERROR'))
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (expectedRevocation.value && /410/.test(text) && /failed to load resource/i.test(text)) return
    consoleErrors.push(text.replace(/https?:\/\/\S+/gi, '[URL]').slice(0, 120))
  })
  page.on('request', (request: HTTPRequest) => {
    void (async () => {
      const url = new URL(request.url())
      const sameOrigin = url.origin === target.origin
      const map = url.hostname.endsWith('openfreemap.org') || url.hostname.endsWith('openstreetmap.org') || url.hostname.endsWith('eox.at')
      let sequence: number | null = null
      if (sameOrigin && request.method() === 'POST' && url.pathname.endsWith('/points')) {
        try { sequence = Number(JSON.parse(request.postData() || '{}').sequence) || null } catch { sequence = null }
      }
      observations.push({ method: request.method(), path: url.pathname, sequence, api: sameOrigin && url.pathname.startsWith('/api/share/') })
      if (url.hostname === 'tiles.openfreemap.org' && url.pathname.replace(/\/$/, '') === '/styles/liberty') {
        return request.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#050505' } }] }) })
      }
      if (map) return request.abort()
      const headers = sameOrigin ? overrideHeaders(request.headers()) : request.headers()
      return request.continue({ headers })
    })().catch(() => request.abort().catch(() => undefined))
  })
}

async function setOnline(page: Page, value: boolean): Promise<void> { await page.evaluate((next) => (window as any).__pilotQA.setOnline(next), value) }
async function setVisibility(page: Page, value: string): Promise<void> { await page.evaluate((next) => (window as any).__pilotQA.setVisibility(next), value) }
async function setClockOffset(page: Page, value: number): Promise<void> { await page.evaluate((next) => (window as any).__pilotQA.setClockOffset(next), value) }
async function emitPoint(page: Page): Promise<void> { await page.evaluate(() => (window as any).__pilotQA.emitPoint()) }
async function stats(page: Page): Promise<FakeStats> { return page.evaluate(() => (window as any).__pilotQA.stats()) }
async function overflow(page: Page): Promise<boolean> { return page.evaluate(() => Math.max(document.body?.scrollWidth || 0, document.documentElement.scrollWidth) > innerWidth) }

let browser: Browser | undefined
const result = {
  schema: 'stracker.controlled-physical-pilot.live-browser.v1',
  sourceSha: expectedSha,
  targetUrl: target.origin + '/',
  privateDataUsed: false,
  realCoordinatesUsed: false,
  syntheticCoordinateValuesRetained: false,
  capabilityOrTokenRetained: false,
  pageErrorTotal: 0,
  relevantConsoleErrors: 0,
  horizontalOverflowTotal: 0,
  offlineDurationSeconds: 30,
  physicalValidation: 'NOT_EXECUTED_AUTOMATED_SYNTHETIC_ONLY',
  gates: {} as Record<string, string>,
}

try {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const [buildResponse, versionResponse] = await Promise.all([
    fetchTarget(`/__stracker/build.json?pilot=${encodeURIComponent(nonce)}`),
    fetchTarget(`/__stracker/version.json?pilot=${encodeURIComponent(nonce)}`),
  ])
  ok(buildResponse.status === 200 && versionResponse.status === 200, 'RUNTIME_IDENTITY_UNAVAILABLE')
  const build = await buildResponse.json() as { sourceSha?: string; release?: string }
  const version = await versionResponse.json() as { sourceSha?: string; versionId?: string }
  ok(build.sourceSha === expectedSha && build.release === 'controlled-physical-pilot-v1', 'BUILD_ASSET_SHA_MATCH')
  ok(version.sourceSha === expectedSha && version.versionId === expectedVersionId, 'VERSION_METADATA_MATCH')

  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--disable-dev-shm-usage'] })
  const emitterContext = await browser.createBrowserContext()
  const tclContext = await browser.createBrowserContext()
  const windowsContext = await browser.createBrowserContext()
  const emitter = await emitterContext.newPage()
  const tcl = await tclContext.newPage()
  const windows = await windowsContext.newPage()
  const emitterRequests: Observation[] = [], tclRequests: Observation[] = [], windowsRequests: Observation[] = []
  const pageErrors: string[] = [], consoleErrors: string[] = []
  const expectedRevocation = { value: false }
  await configure(emitter, { width: 360, height: 800, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, emitterRequests, pageErrors, consoleErrors, expectedRevocation)
  await configure(tcl, { width: 360, height: 800, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, tclRequests, pageErrors, consoleErrors, expectedRevocation)
  await configure(windows, { width: 1366, height: 768, deviceScaleFactor: 1, isMobile: false, hasTouch: false }, windowsRequests, pageErrors, consoleErrors, expectedRevocation)

  await emitter.goto(new URL('/share', target).href, { waitUntil: 'networkidle0', timeout: 60_000 })
  const prestart = await emitter.evaluate(() => document.body.textContent || '')
  ok(prestart.includes('SÓLO EN PRIMER PLANO') && prestart.includes('no promete seguimiento en segundo plano'), 'FOREGROUND_ONLY_NOTICE')
  ok(!emitterRequests.some((entry) => entry.api), 'NO_SESSION_BEFORE_START')
  await click(emitter, 'INICIAR TRANSMISIÓN')
  await emitter.waitForSelector('main[data-sharing-state="active"]', { timeout: 60_000 })
  await emitter.waitForSelector('input[aria-label="Enlace privado de espectador"]', { timeout: 60_000 })
  await emitPoint(emitter)
  await emitter.waitForFunction(() => document.body.textContent?.includes('AHORA'), { timeout: 30_000 })
  ok((await stats(emitter)).wakeHeld, 'WAKE_LOCK_HELD')
  const activeText = await emitter.evaluate(() => document.body.textContent || '')
  ok(activeText.includes('COMPARTIR') && activeText.includes('BUENA'), 'SHARE_AND_ACCURACY_VISIBLE')
  const link = await emitter.$eval('input[aria-label="Enlace privado de espectador"]', (input: Element) => (input as HTMLInputElement).value)

  for (const viewer of [tcl, windows]) {
    await viewer.goto(link, { waitUntil: 'networkidle0', timeout: 60_000 })
    ok((await viewer.evaluate(() => document.body.textContent || '')).includes('VER UBICACIÓN'), 'EXPLICIT_CONFIRMATION')
    await click(viewer, 'VER UBICACIÓN')
    await viewer.waitForFunction(() => location.hash === '' && location.search === '', { timeout: 30_000 })
    await viewer.waitForSelector('[data-pilot-freshness="fresh"]', { timeout: 60_000 })
    ok(!(await overflow(viewer)), 'VIEWER_OVERFLOW')
  }

  await setClockOffset(tcl, 20_000); await setClockOffset(windows, 20_000)
  await tcl.waitForSelector('[data-pilot-freshness="delayed"]', { timeout: 10_000 })
  await windows.waitForSelector('[data-pilot-freshness="delayed"]', { timeout: 10_000 })
  await setClockOffset(tcl, 50_000); await setClockOffset(windows, 50_000)
  await tcl.waitForSelector('[data-pilot-freshness="stale"]', { timeout: 10_000 })
  await windows.waitForSelector('[data-pilot-freshness="stale"]', { timeout: 10_000 })
  await setClockOffset(tcl, 0); await setClockOffset(windows, 0)

  const beforeOffline = emitterRequests.filter((entry) => entry.path.endsWith('/points')).length
  await setOnline(emitter, false)
  await emitter.waitForSelector('main[data-network-state="offline"]', { timeout: 10_000 })
  for (let index = 0; index < 6; index += 1) { await sleep(5_000); await emitPoint(emitter) }
  ok(emitterRequests.filter((entry) => entry.path.endsWith('/points')).length === beforeOffline, 'NO_OFFLINE_PUBLICATION')
  await click(emitter, 'COPIAR DIAGNÓSTICO')
  const diagnosticText = (await stats(emitter)).clipboard
  const diagnostic = JSON.parse(diagnosticText) as Record<string, unknown>
  const expectedKeys = ['BUILD_SHA','VERSION_ID','BROWSER_AND_OS_CLASS','PAGE_VISIBILITY_STATE','GEOLOCATION_PERMISSION_STATE','NETWORK_ONLINE_STATE','WAKE_LOCK_SUPPORTED_AND_HELD','LAST_HTTP_STATUS_CATEGORY','POINT_ATTEMPT_COUNT','POINT_SUCCESS_COUNT','LAST_SUCCESS_AGE_BUCKET'].sort()
  ok(JSON.stringify(Object.keys(diagnostic).sort()) === JSON.stringify(expectedKeys), 'DIAGNOSTIC_ALLOWLIST')
  for (const forbidden of ['lat','lng','accuracyM','capability','viewerSession','sessionId','Authorization','#v=']) ok(!diagnosticText.includes(forbidden), `DIAGNOSTIC_FORBIDDEN_${forbidden}`)

  await setOnline(emitter, true)
  await emitter.waitForFunction(() => document.querySelector('main')?.getAttribute('data-network-state') === 'online', { timeout: 30_000 })
  await sleep(3_000)
  const published = emitterRequests.filter((entry) => entry.path.endsWith('/points'))
  ok(published.length === beforeOffline + 1, 'LATEST_POINT_ONLY_RECOVERY')
  const sequences = published.map((entry) => entry.sequence).filter((value): value is number => Number.isSafeInteger(value))
  ok(new Set(sequences).size === sequences.length, 'NO_DUPLICATE_SEQUENCE')
  ok(sequences.every((value, index) => index === 0 || value > sequences[index - 1]), 'NO_OUT_OF_ORDER_SEQUENCE')

  await setVisibility(emitter, 'hidden')
  await emitter.waitForSelector('main[data-sharing-state="paused"]', { timeout: 10_000 })
  ok(!(await stats(emitter)).wakeHeld, 'WAKE_LOCK_RELEASE_HIDDEN')
  const beforeHidden = emitterRequests.filter((entry) => entry.path.endsWith('/points')).length
  await emitPoint(emitter); await sleep(1_000)
  ok(emitterRequests.filter((entry) => entry.path.endsWith('/points')).length === beforeHidden, 'NO_BACKGROUND_PUBLICATION')
  await setVisibility(emitter, 'visible')
  await emitter.waitForFunction(() => document.querySelector('main')?.getAttribute('data-wake-lock-held') === 'true', { timeout: 10_000 })
  ok((await stats(emitter)).wakeRequests >= 2, 'WAKE_LOCK_REACQUIRE')

  expectedRevocation.value = true
  await click(emitter, 'DETENER Y REVOCAR ENLACE')
  await emitter.waitForSelector('main[data-sharing-state="revoked"]', { timeout: 30_000 })
  for (const viewer of [tcl, windows]) {
    await viewer.waitForSelector('main[data-viewer-state="revoked"]', { timeout: 30_000 })
    ok((await viewer.$$('main[data-map-engine]')).length === 0, 'REVOCATION_REMOVES_MAP')
  }
  ok(!(await stats(emitter)).wakeHeld, 'WAKE_LOCK_RELEASE_STOP')

  result.pageErrorTotal = pageErrors.length
  result.relevantConsoleErrors = consoleErrors.length
  result.horizontalOverflowTotal = Number(await overflow(emitter)) + Number(await overflow(tcl)) + Number(await overflow(windows))
  ok(result.pageErrorTotal === 0, 'PAGEERROR_TOTAL')
  ok(result.relevantConsoleErrors === 0, 'RELEVANT_CONSOLE_ERRORS')
  ok(result.horizontalOverflowTotal === 0, 'HORIZONTAL_OVERFLOW_TOTAL')
  result.gates = {
    VERSION_METADATA_MATCH: 'PASS', BUILD_ASSET_SHA_MATCH: 'PASS',
    VISIBILITY_FOREGROUND_CONTRACT_TESTS: 'PASS', NO_BACKGROUND_RELIABILITY_CLAIM_TEST: 'PASS',
    WAKE_LOCK_FEATURE_DETECTION_TESTS: 'PASS', WAKE_LOCK_RELEASE_TESTS: 'PASS',
    LATEST_POINT_ONLY_RETRY_TESTS: 'PASS', OFFLINE_30_SECOND_RECOVERY_TEST: 'PASS',
    NO_DUPLICATE_OR_OUT_OF_ORDER_TEST: 'PASS', FRESH_DELAYED_STALE_UI_TESTS: 'PASS',
    REVOCATION_REMOVES_MAP_TEST: 'PASS', SANITIZED_DIAGNOSTIC_SCAN: 'PASS',
    A22_VIEWPORT_BROWSER_E2E: 'PASS', TCL408_VIEWPORT_BROWSER_E2E: 'PASS', WINDOWS_CHROME_VIEWPORT_E2E: 'PASS',
  }
  await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
  console.log(`LIVE_CONTROLLED_PHYSICAL_PILOT_BROWSER_QA=PASS sha=${expectedSha}`)
} catch (error) {
  console.error(`LIVE_CONTROLLED_PHYSICAL_PILOT_BROWSER_QA=FAIL code=${error instanceof QaFailure ? error.code : 'UNEXPECTED'}`)
  throw error
} finally {
  await browser?.close()
}
