// @ts-nocheck
import puppeteer from 'puppeteer-core'

const target = new URL(process.env.STRACKER_QA_URL || '')
const expectedSha = process.env.STRACKER_EXPECTED_SHA || ''
const overrideVersion = process.env.STRACKER_VERSION_OVERRIDE || ''
const chrome = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const output = process.env.STRACKER_QA_OUTPUT || '/tmp/stracker-minimum-runtime-qa.json'
const allowHttp = process.env.STRACKER_QA_ALLOW_HTTP === '1'
const sizes = [[320, 568], [360, 640], [375, 812], [390, 844], [412, 915]]
const coordinateNeedles = ['10.1234', '20.5678']

if (!target.hostname || !expectedSha) throw new Error('QA_INPUT_REQUIRED')
if (!allowHttp && target.protocol !== 'https:') throw new Error('HTTPS_REQUIRED')

class QaFailure extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function ok(value, code) {
  if (!value) throw new QaFailure(code)
}

async function click(page, text) {
  await page.waitForFunction(
    (value) => [...document.querySelectorAll('button')].some((button) => button.textContent?.toUpperCase().includes(String(value).toUpperCase())),
    {},
    text,
  )
  await page.$$eval('button', (buttons, value) => {
    const button = buttons.find((candidate) => candidate.textContent?.toUpperCase().includes(String(value).toUpperCase()))
    if (!button) throw new Error('BUTTON_NOT_FOUND')
    button.click()
  }, text)
}

async function overflow(page) {
  return page.evaluate(() => Math.max(
    document.body?.scrollWidth || 0,
    document.documentElement.scrollWidth,
  ) > innerWidth)
}

async function geolocationStats(page) {
  return page.evaluate(() => window.__strackerGeoQa.stats())
}

function requestHeaders() {
  if (!overrideVersion) return {}
  return { 'Cloudflare-Workers-Version-Overrides': `stracker="${overrideVersion}"` }
}

async function qaPage(context, width, height, observations) {
  const page = await context.newPage()
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await page.evaluateOnNewDocument(() => {
    let watchId = 0
    const active = new Set()
    const stats = { get: 0, watch: 0, clear: 0 }
    const point = () => ({
      coords: {
        latitude: 10.12341,
        longitude: 20.56781,
        accuracy: 8,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: 0,
        toJSON: () => ({}),
      },
      timestamp: Date.now(),
      toJSON: () => ({}),
    })
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) {
          stats.get += 1
          setTimeout(() => success(point()), 0)
        },
        watchPosition(success) {
          stats.watch += 1
          const id = ++watchId
          active.add(id)
          setTimeout(() => {
            if (active.has(id)) success(point())
          }, 0)
          return id
        },
        clearWatch(id) {
          stats.clear += 1
          active.delete(id)
        },
      },
    })
    Object.defineProperty(window, '__strackerGeoQa', {
      value: { stats: () => ({ ...stats, active: active.size }) },
    })
  })
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const url = new URL(request.url())
    const sameOrigin = url.origin === target.origin
    const body = request.postData() || ''
    observations.push({
      api: sameOrigin && url.pathname.startsWith('/api/'),
      map: url.hostname.endsWith('openfreemap.org') || url.hostname.endsWith('openstreetmap.org'),
      coordinate: coordinateNeedles.some((needle) => request.url().includes(needle) || body.includes(needle)),
    })
    const headers = sameOrigin && overrideVersion
      ? { ...request.headers(), ...requestHeaders() }
      : request.headers()
    request.continue({ headers }).catch(() => undefined)
  })
  return page
}

async function fetchTarget(path, init = {}) {
  const headers = new Headers(init.headers || {})
  for (const [key, value] of Object.entries(requestHeaders())) headers.set(key, value)
  return fetch(new URL(path, target), { ...init, headers, redirect: 'error' })
}

let browser
const result = {
  schema: 'stracker.same-domain-minimum-runtime-qa.v1',
  sourceSha: expectedSha,
  targetUrl: target.origin + '/',
  privateDataUsed: false,
  realCoordinatesUsed: false,
  coordinateValuesRetained: false,
  secretValuesRetained: false,
  pageErrorTotal: 0,
  horizontalOverflowTotal: 0,
  physicalGeolocationValidation: 'NOT_EXECUTED_ENV_BLOCKED',
  viewports: [],
  gates: {},
}

try {
  const buildResponse = await fetchTarget('/__stracker/build.json', { cache: 'no-store' })
  ok(buildResponse.status === 200, 'BUILD_INFO_UNAVAILABLE')
  const buildInfo = await buildResponse.json()
  ok(buildInfo.sourceSha === expectedSha, 'RUNTIME_SHA_MISMATCH')
  ok(buildInfo.release === 'same-domain-minimum-usable-v1', 'RELEASE_LABEL_MISMATCH')

  const apiResponse = await fetchTarget('/api/share/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: target.origin },
    body: '{}',
  })
  ok(apiResponse.status === 503, 'SHARED_API_NOT_FAIL_CLOSED')
  ok((await apiResponse.json()).error === 'SHARED_LOCATION_NOT_AVAILABLE', 'SHARED_API_ERROR_UNSANITIZED')

  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
  })

  for (const [width, height] of sizes) {
    const context = await browser.createBrowserContext()
    const observations = []
    const pageErrors = []
    const page = await qaPage(context, width, height, observations)
    page.on('pageerror', () => pageErrors.push(true))

    await page.goto(target.href, { waitUntil: 'networkidle0', timeout: 60_000 })
    await page.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'))
    const rootObservationCount = observations.length
    ok(!(await overflow(page)), 'ROOT_OVERFLOW')
    ok(!(await page.$('main[data-map-engine]')), 'MAP_BEFORE_SELECTION')
    let geo = await geolocationStats(page)
    ok(geo.get === 0 && geo.watch === 0, 'GEOLOCATION_BEFORE_SELECTION')
    ok(observations.slice(0, rootObservationCount).every((entry) => !entry.api && !entry.map), 'NETWORK_BEFORE_SELECTION')

    await click(page, 'UBICACIÓN COMPARTIDA')
    await page.waitForSelector('main[data-shared-runtime="unavailable"]')
    ok((await page.evaluate(() => document.body.textContent || '')).includes('NO DISPONIBLE EN ESTA PREVIEW'), 'SHARED_UNAVAILABLE_COPY_MISSING')
    ok(!(await page.$('main[data-map-engine]')), 'SHARED_MAP_CREATED')
    geo = await geolocationStats(page)
    ok(geo.get === 0 && geo.watch === 0, 'SHARED_GEOLOCATION_STARTED')
    ok(observations.slice(rootObservationCount).every((entry) => !entry.api && !entry.map), 'SHARED_NETWORK_STARTED')

    await page.click('button[aria-label="Volver"]')
    await page.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'))
    await click(page, 'MI UBICACIÓN')
    await page.waitForFunction(() => document.body.textContent?.includes('PERMITIR UBICACIÓN'))
    geo = await geolocationStats(page)
    ok(geo.get === 0 && geo.watch === 0, 'GEOLOCATION_BEFORE_PERMISSION')

    const beforePermissionRequests = observations.length
    await click(page, 'PERMITIR UBICACIÓN')
    await page.waitForSelector('main[data-map-engine="maplibre"][data-location-source="my-device"]', { timeout: 60_000 })
    geo = await geolocationStats(page)
    ok(geo.get === 0 && geo.watch === 1 && geo.active === 1, 'WATCH_POSITION_CONTRACT')
    ok(observations.slice(beforePermissionRequests).every((entry) => !entry.api && !entry.coordinate), 'OWN_COORDINATE_TRANSPORT')
    ok(await page.$eval('main[data-map-engine]', (node) => node.dataset.reducedMotion) === 'true', 'REDUCED_MOTION')
    const attribution = await page.$eval('[aria-label="Atribución del mapa"]', (node) => node.textContent || '')
    ok(attribution.includes('OpenFreeMap') && attribution.includes('OpenStreetMap'), 'MAP_ATTRIBUTION')
    ok(!(await overflow(page)), 'MAP_OVERFLOW')

    await page.$eval('section[aria-label="Estado de ubicación"] > button', (button) => button.click())
    await click(page, 'Cambiar ubicación')
    await page.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'))
    geo = await geolocationStats(page)
    ok(geo.clear >= 1 && geo.active === 0, 'SOURCE_SWITCH_CLEANUP')
    ok(!(await page.$('main[data-map-engine]')), 'MAP_NOT_CLEARED')

    result.pageErrorTotal += pageErrors.length
    result.horizontalOverflowTotal += await overflow(page) ? 1 : 0
    result.viewports.push({ width, height, pageErrors: pageErrors.length, horizontalOverflow: 0 })
    await context.close()
  }

  ok(result.pageErrorTotal === 0, 'PAGEERROR_TOTAL')
  ok(result.horizontalOverflowTotal === 0, 'HORIZONTAL_OVERFLOW_TOTAL')
  result.gates = {
    HTTPS: allowHttp ? 'LOCAL_HTTP_ALLOWED' : 'PASS',
    SAME_WORKERS_DEV_DOMAIN: target.hostname === 'stracker.simondalmasso44.workers.dev' ? 'PASS' : 'PREVIEW_OR_LOCAL',
    ROOT_SELECTOR_ALWAYS_FIRST: 'PASS',
    NO_MAP_OR_GEOLOCATION_BEFORE_SELECTION: 'PASS',
    MY_LOCATION_EXPLICIT_CONSENT: 'PASS',
    WATCH_POSITION: 'PASS',
    COORDINATES_SENT_TO_BACKEND: 'NO',
    SHARED_LOCATION_FAIL_CLOSED: 'PASS',
    MAPLIBRE_ONLY: 'PASS',
    OPENFREEMAP_OSM_ATTRIBUTION: 'PASS',
    SOURCE_SWITCH_CLEANUP: 'PASS',
    RUNTIME_SHA_MATCH: 'PASS',
  }
  await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
  console.log(`MINIMUM_RUNTIME_QA=PASS target=${result.targetUrl} sha=${expectedSha}`)
} catch (error) {
  console.error(`MINIMUM_RUNTIME_QA=FAIL code=${error instanceof QaFailure ? error.code : 'UNEXPECTED'}`)
  throw error
} finally {
  await browser?.close()
}
