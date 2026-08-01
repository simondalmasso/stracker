import puppeteer, {
  type Browser,
  type ConsoleMessage,
  type HTTPRequest,
  type Page,
} from 'puppeteer-core'

const target = new URL(process.env.STRACKER_QA_URL || '')
const expectedSha = process.env.STRACKER_EXPECTED_SHA || ''
const expectedVersionId = process.env.STRACKER_EXPECTED_VERSION_ID || ''
const overrideVersion = process.env.STRACKER_VERSION_OVERRIDE || ''
const chrome = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const output = process.env.STRACKER_BROWSER_QA_OUTPUT || '/tmp/stracker-native-sharing-browser-qa.json'
const sizes = [[320, 568], [360, 640], [375, 812], [390, 844], [412, 915]] as const

if (target.protocol !== 'https:' || !target.hostname) throw new Error('HTTPS_TARGET_REQUIRED')
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('EXPECTED_SHA_REQUIRED')
if (!expectedVersionId) throw new Error('EXPECTED_VERSION_ID_REQUIRED')

class QaFailure extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function ok(value: unknown, code: string): asserts value {
  if (!value) throw new QaFailure(code)
}

function consoleErrorCategory(message: ConsoleMessage): string {
  const text = message.text()
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/[A-Za-z0-9_-]{43}(?:\.[A-Za-z0-9_-]{43})?/g, '[CAPABILITY]')
    .replace(/Bearer\s+[A-Za-z0-9_-]+/gi, 'Bearer [TOKEN]')

  if (/webgl|swiftshader|gpu process|graphics context/i.test(text)) return 'WEBGL_RENDERER'
  if (/maplibre|openfreemap|openstreetmap|styleimagemissing/i.test(text)) return 'MAP_RENDERER'
  if (/failed to load resource|status of 4\d\d|status of 5\d\d/i.test(text)) return 'RESOURCE_LOAD'
  if (/fetch|network|net::err_|load failed|abort/i.test(text)) return 'NETWORK_REQUEST'
  if (/content security policy|permissions policy|cors|cross-origin/i.test(text)) return 'BROWSER_POLICY'
  if (/react|uncaught|typeerror|referenceerror|rangeerror|syntaxerror/i.test(text)) return 'APPLICATION_RUNTIME'
  return 'UNCLASSIFIED_CONSOLE_ERROR'
}

async function click(page: Page, text: string): Promise<void> {
  await page.waitForFunction(
    (value: string) => Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.toUpperCase().includes(value.toUpperCase())),
    {},
    text,
  )
  await page.$$eval('button', (elements: Element[], value: string) => {
    const buttons = elements as HTMLButtonElement[]
    const button = buttons.find((candidate) => candidate.textContent?.toUpperCase().includes(value.toUpperCase()))
    if (!button) throw new Error('BUTTON_NOT_FOUND')
    button.click()
  }, text)
}

async function overflow(page: Page): Promise<boolean> {
  return page.evaluate(() => Math.max(document.body?.scrollWidth || 0, document.documentElement.scrollWidth) > innerWidth)
}

async function installGeolocation(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    let watchId = 0
    let sequence = 0
    const active = new Map<number, PositionCallback>()
    const stats = { get: 0, watch: 0, clear: 0 }
    const position = (): GeolocationPosition => {
      sequence += 1
      return {
        coords: {
          latitude: 10.1234 + sequence * 0.00001,
          longitude: 20.5678 + sequence * 0.00001,
          accuracy: 8,
          altitude: null,
          altitudeAccuracy: null,
          heading: 30,
          speed: 1,
          toJSON: () => ({}),
        },
        timestamp: Date.now() + sequence * 6_000,
        toJSON: () => ({}),
      }
    }
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success: PositionCallback) {
          stats.get += 1
          setTimeout(() => success(position()), 0)
        },
        watchPosition(success: PositionCallback) {
          stats.watch += 1
          const id = ++watchId
          active.set(id, success)
          setTimeout(() => {
            if (active.has(id)) success(position())
          }, 100)
          return id
        },
        clearWatch(id: number) {
          stats.clear += 1
          active.delete(id)
        },
      },
    })
    Object.defineProperty(window, '__strackerGeoQa', {
      value: { stats: () => ({ ...stats, active: active.size }) },
    })
  })
}

interface RequestObservation {
  api: boolean
  map: boolean
  query: boolean
  method: string
  pathname: string
}

async function configurePage(
  page: Page,
  width: number,
  height: number,
  observations: RequestObservation[],
  pageErrors: string[],
  consoleErrors: string[],
): Promise<void> {
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await installGeolocation(page)
  await page.setRequestInterception(true)
  page.on('pageerror', (error: unknown) => {
    pageErrors.push(error instanceof Error ? error.name : 'pageerror')
  })
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') consoleErrors.push(consoleErrorCategory(message))
  })
  page.on('request', (request: HTTPRequest) => {
    void (async () => {
      const url = new URL(request.url())
      const sameOrigin = url.origin === target.origin
      const map = url.hostname.endsWith('openfreemap.org') || url.hostname.endsWith('openstreetmap.org')
      observations.push({
        api: sameOrigin && url.pathname.startsWith('/api/share/'),
        map,
        query: Boolean(url.search),
        method: request.method(),
        pathname: url.pathname,
      })
      const requestHeaders = request.headers()
      const nextHeaders = sameOrigin && overrideVersion
        ? { ...requestHeaders, 'Cloudflare-Workers-Version-Overrides': `stracker="${overrideVersion}"` }
        : requestHeaders
      await request.continue({ headers: nextHeaders })
    })().catch(() => request.abort().catch(() => undefined))
  })
}

async function geoStats(page: Page): Promise<{ get: number; watch: number; clear: number; active: number }> {
  return page.evaluate(() => (window as unknown as { __strackerGeoQa: { stats: () => { get: number; watch: number; clear: number; active: number } } }).__strackerGeoQa.stats())
}

async function viewerMemory(page: Page, capability: string): Promise<void> {
  const state = await page.evaluate(async (value: string) => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookie: document.cookie,
    databases: 'databases' in indexedDB ? (await indexedDB.databases()).length : 0,
    fragment: location.hash,
    query: location.search,
    domContainsCapability: document.documentElement.innerHTML.includes(value),
  }), capability)
  ok(state.local === 0 && state.session === 0 && state.cookie === '' && state.databases === 0, 'VIEWER_CLIENT_PERSISTENCE')
  ok(state.fragment === '' && state.query === '', 'FRAGMENT_REMOVAL')
  ok(state.domContainsCapability === false, 'CAPABILITY_RETAINED_IN_DOM')
}

let browser: Browser | undefined
const allConsoleCategories: string[] = []
const result = {
  schema: 'stracker.native-sharing-live-browser-qa.v1',
  sourceSha: expectedSha,
  targetUrl: target.origin + '/',
  privateDataUsed: false,
  realCoordinatesUsed: false,
  syntheticCoordinateValuesRetained: false,
  capabilityOrTokenRetained: false,
  pageErrorTotal: 0,
  relevantConsoleErrors: 0,
  horizontalOverflowTotal: 0,
  viewports: [] as Array<{ width: number; height: number; pageErrors: number; relevantConsoleErrors: number; horizontalOverflow: number }>,
  gates: {} as Record<string, string>,
}

try {
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  })

  for (const [width, height] of sizes) {
    const emitterContext = await browser.createBrowserContext()
    const viewerContext = await browser.createBrowserContext()
    const emitterObservations: RequestObservation[] = []
    const viewerObservations: RequestObservation[] = []
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    const emitter = await emitterContext.newPage()
    const viewer = await viewerContext.newPage()
    await configurePage(emitter, width, height, emitterObservations, pageErrors, consoleErrors)
    await configurePage(viewer, width, height, viewerObservations, pageErrors, consoleErrors)

    await emitter.goto(target.href, { waitUntil: 'networkidle0', timeout: 60_000 })
    await emitter.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'))
    ok(!(await overflow(emitter)), 'ROOT_OVERFLOW')
    const rootGeo = await geoStats(emitter)
    ok(rootGeo.get === 0 && rootGeo.watch === 0, 'ROOT_GEOLOCATION')
    ok(emitterObservations.every((entry) => !entry.api && !entry.map), 'ROOT_NETWORK')
    ok((await emitter.$$('main[data-map-engine]')).length === 0, 'ROOT_MAP')

    await emitter.goto(new URL('/share', target).href, { waitUntil: 'networkidle0', timeout: 60_000 })
    await emitter.waitForFunction(() => document.body.textContent?.includes('INICIAR TRANSMISIÓN'))
    const beforeStart = emitterObservations.length
    const emitterBeforeGeo = await geoStats(emitter)
    ok(emitterBeforeGeo.get === 0 && emitterBeforeGeo.watch === 0, 'EMITTER_GEO_BEFORE_START')
    ok(emitterObservations.slice(0, beforeStart).every((entry) => !entry.api), 'SESSION_BEFORE_START')

    await click(emitter, 'INICIAR TRANSMISIÓN')
    await emitter.waitForSelector('input[aria-label="Enlace privado de espectador"]', { timeout: 60_000 })
    await emitter.waitForSelector('main[data-sharing-state="active"]', { timeout: 60_000 })
    const link = await emitter.$eval('input[aria-label="Enlace privado de espectador"]', (element: Element) => (element as HTMLInputElement).value)
    const capability = new URL(link).hash.replace(/^#v=/, '')
    ok(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(capability), 'VIEWER_CAPABILITY_FORMAT')
    const emitterGeo = await geoStats(emitter)
    ok(emitterGeo.get === 1 && emitterGeo.watch === 1 && emitterGeo.active === 1, 'EMITTER_WATCH_POSITION')
    await emitter.waitForFunction(() => document.body.textContent?.includes('AHORA'), { timeout: 30_000 })
    ok(emitterObservations.some((entry) => entry.api && entry.method === 'POST' && entry.pathname === '/api/share/sessions'), 'SESSION_CREATE_REQUEST')
    ok(emitterObservations.some((entry) => entry.api && entry.method === 'POST' && entry.pathname.endsWith('/points')), 'POINT_PUBLICATION_REQUEST')

    await viewer.goto(new URL(`/shared#v=${encodeURIComponent(capability)}`, target).href, { waitUntil: 'networkidle0', timeout: 60_000 })
    await viewer.waitForFunction(() => document.body.textContent?.includes('VER UBICACIÓN'))
    ok(!(await overflow(viewer)), 'VIEWER_PRECONFIRM_OVERFLOW')
    ok(viewerObservations.every((entry) => !entry.api), 'VIEWER_API_BEFORE_CONFIRMATION')
    ok((await viewer.$$('main[data-map-engine]')).length === 0, 'VIEWER_MAP_BEFORE_CONFIRMATION')
    const viewerGeo = await geoStats(viewer)
    ok(viewerGeo.get === 0 && viewerGeo.watch === 0, 'VIEWER_GEOLOCATION')

    await click(viewer, 'VER UBICACIÓN')
    await viewer.waitForFunction(() => location.pathname === '/shared' && location.search === '' && location.hash === '', { timeout: 30_000 })
    await viewer.waitForSelector('main[data-map-engine="maplibre"][data-location-source="shared-location"]', { timeout: 60_000 })
    await viewerMemory(viewer, capability)
    ok(viewerObservations.filter((entry) => entry.pathname === '/api/share/viewer/exchange').length === 1, 'CAPABILITY_EXCHANGE_ONCE')
    ok(viewerObservations.some((entry) => entry.method === 'GET' && entry.pathname.endsWith('/status')), 'VIEWER_STATUS_POLL')
    ok(viewerObservations.some((entry) => entry.method === 'GET' && entry.pathname.endsWith('/points')), 'VIEWER_POINTS_POLL')
    const attribution = await viewer.$eval('[aria-label="Atribución del mapa"]', (element: Element) => element.textContent || '')
    ok(attribution.includes('OpenFreeMap') && attribution.includes('OpenStreetMap'), 'MAP_ATTRIBUTION')
    ok(!(await overflow(viewer)), 'VIEWER_MAP_OVERFLOW')

    await click(emitter, 'REVOCAR ENLACE')
    await viewer.waitForFunction(() => document.querySelector('main[data-viewer-state="revoked"]') && !document.querySelector('main[data-map-engine]'), { timeout: 30_000 })
    const emitterAfter = await geoStats(emitter)
    ok(emitterAfter.clear >= 1 && emitterAfter.active === 0, 'EMITTER_REVOCATION_CLEANUP')

    const viewportErrors = pageErrors.length
    const viewportConsoleErrors = consoleErrors.length
    const viewportOverflow = Number(await overflow(emitter) || await overflow(viewer))
    allConsoleCategories.push(...consoleErrors)
    result.pageErrorTotal += viewportErrors
    result.relevantConsoleErrors += viewportConsoleErrors
    result.horizontalOverflowTotal += viewportOverflow
    result.viewports.push({ width, height, pageErrors: viewportErrors, relevantConsoleErrors: viewportConsoleErrors, horizontalOverflow: viewportOverflow })

    await emitterContext.close()
    await viewerContext.close()
  }

  ok(result.pageErrorTotal === 0, 'PAGEERROR_TOTAL')
  if (result.relevantConsoleErrors !== 0) {
    const categories = [...new Set(allConsoleCategories)].sort().join(',') || 'UNKNOWN'
    console.error(`LIVE_BROWSER_CONSOLE_CATEGORIES=${categories}`)
  }
  ok(result.relevantConsoleErrors === 0, 'RELEVANT_CONSOLE_ERRORS')
  ok(result.horizontalOverflowTotal === 0, 'HORIZONTAL_OVERFLOW_TOTAL')
  result.gates = {
    ROOT_SELECTOR_ALWAYS_FIRST: 'PASS',
    NO_MAP_OR_GEOLOCATION_BEFORE_SELECTION: 'PASS',
    EXPLICIT_EMITTER_START: 'PASS',
    NO_SESSION_OR_GEOLOCATION_BEFORE_START: 'PASS',
    FIRST_CONFIRMED_POINT_PUBLICATION: 'PASS',
    EXPLICIT_VIEW_CONFIRMATION: 'PASS',
    NO_EXCHANGE_STATUS_POINTS_OR_MAP_BEFORE_CONFIRMATION: 'PASS',
    CAPABILITY_EXCHANGED_ONCE: 'PASS',
    FRAGMENT_REMOVAL: 'PASS',
    VIEWER_SESSION_MEMORY_ONLY: 'PASS',
    TWO_ISOLATED_BROWSER_CONTEXTS: 'PASS',
    ALL_REQUIRED_VIEWPORTS: 'PASS',
    MAP_ATTRIBUTION: 'PASS',
    REVOCATION_AND_CLEANUP: 'PASS',
  }
  await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
  console.log(`LIVE_NATIVE_SHARING_BROWSER_QA=PASS sha=${expectedSha}`)
} catch (error) {
  console.error(`LIVE_NATIVE_SHARING_BROWSER_QA=FAIL code=${error instanceof QaFailure ? error.code : 'UNEXPECTED'}`)
  throw error
} finally {
  await browser?.close()
}
