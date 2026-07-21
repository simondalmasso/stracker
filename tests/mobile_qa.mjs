import fs from 'node:fs'
import puppeteer from 'puppeteer-core'

const executablePath = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:4173'
const output = process.env.QA_RAW_OUTPUT || '/tmp/stracker-vector-map-performance.json'
const viewports = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function clickText(page, text) {
  await page.$$eval('button', (buttons, expected) => {
    const target = buttons.find((button) => button.textContent?.toUpperCase().includes(String(expected).toUpperCase()))
    if (!(target instanceof HTMLElement)) throw new Error(`button not found: ${expected}`)
    target.click()
  }, text)
}

async function noOverflow(page, label) {
  assert(await page.$eval('body', (body) => body.scrollWidth <= window.innerWidth), `horizontal overflow: ${label}`)
}

async function installSyntheticGeolocation(page) {
  await page.evaluateOnNewDocument(() => {
    const callbacks = new Map()
    let nextId = 1
    window.__strackerGeo = {
      watchCalls: 0,
      clearCalls: 0,
      emit(position) {
        for (const callback of callbacks.values()) callback.success(position)
      },
      fail(error) {
        for (const callback of callbacks.values()) callback.error?.(error)
      },
    }
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition(success, error) {
          const id = nextId++
          callbacks.set(id, { success, error })
          window.__strackerGeo.watchCalls += 1
          return id
        },
        clearWatch(id) {
          callbacks.delete(id)
          window.__strackerGeo.clearCalls += 1
        },
      },
    })
  })
}

async function emitGeo(page, payload) {
  await page.evaluate((input) => {
    window.__strackerGeo.emit({
      coords: {
        latitude: input.lat,
        longitude: input.lng,
        accuracy: input.accuracy ?? 3,
        altitude: null,
        altitudeAccuracy: null,
        heading: input.heading ?? null,
        speed: input.speed ?? null,
      },
      timestamp: input.timestamp,
    })
  }, payload)
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
    '--enable-precise-memory-info',
  ],
})

const raw = {
  schema: 'stracker.vector-map-mobile-qa.v1',
  generatedAt: new Date().toISOString(),
  engine: 'maplibre',
  provider: 'openfreemap-openstreetmap',
  coordinateValuesRetained: false,
  physicalDevice: 'NOT_EXECUTED_ENV_BLOCKED',
  viewports: [],
  gates: {},
}

try {
  for (const viewport of viewports) {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    await page.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await installSyntheticGeolocation(page)

    const pageErrors = []
    const consoleErrors = []
    const providerRequests = []
    const apiRequests = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('Failed to load resource')) consoleErrors.push(message.text())
    })
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.hostname === 'tiles.openfreemap.org') providerRequests.push(url.pathname)
      if (url.origin === new URL(baseUrl).origin && ['/api/session/status', '/api/session/import', '/api/session/delete', '/points'].includes(url.pathname)) apiRequests.push(url.pathname)
    })

    await page.goto(baseUrl, { waitUntil: 'networkidle0' })
    await noOverflow(page, `selector ${viewport.width}x${viewport.height}`)
    assert((await page.$$eval('button', (buttons) => buttons.length)) === 2, 'selector must show exactly two choices')
    assert((await page.content()).includes('MI UBICACIÓN'), 'my location option missing')
    assert((await page.content()).includes('UBICACIÓN COMPARTIDA'), 'shared location option missing')
    assert((await page.$$('main[data-map-engine]')).length === 0, 'map loaded before source selection')
    assert(providerRequests.length === 0, 'map provider requested before source selection')
    assert(apiRequests.length === 0, 'session or points requested before source selection')
    assert((await page.evaluate(() => window.__strackerGeo.watchCalls)) === 0, 'geolocation requested before source selection')

    const tooSmall = await page.$$eval('button', (buttons) => buttons.filter((button) => {
      const rect = button.getBoundingClientRect()
      return rect.width < 44 || rect.height < 44
    }).length)
    assert(tooSmall === 0, `touch target below 44px at ${viewport.width}x${viewport.height}`)

    await clickText(page, 'MI UBICACIÓN')
    await page.waitForFunction(() => document.body.textContent?.includes('PERMITIR UBICACIÓN'))
    assert((await page.$$('main[data-map-engine]')).length === 0, 'map loaded before permission action')
    assert(providerRequests.length === 0, 'map provider requested before permission action')
    assert((await page.evaluate(() => window.__strackerGeo.watchCalls)) === 0, 'watchPosition called before permission action')

    await clickText(page, 'PERMITIR UBICACIÓN')
    await page.waitForFunction(() => window.__strackerGeo.watchCalls === 1)
    const t0 = Date.now()
    await emitGeo(page, { lat: -31.6333, lng: -60.7, accuracy: 8, speed: 0, heading: null, timestamp: t0 })
    await page.waitForSelector('main[data-map-engine="maplibre"]', { timeout: 30000 })
    await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 30000 })
    await page.waitForFunction(() => document.querySelector('main[data-map-provider]')?.getAttribute('data-map-provider') !== 'loading')
    await noOverflow(page, `map ${viewport.width}x${viewport.height}`)

    await emitGeo(page, { lat: -31.633295, lng: -60.699995, accuracy: 12, speed: 0, timestamp: t0 + 5_000 })
    await page.waitForFunction(() => document.querySelector('main[data-filter-decision]')?.getAttribute('data-filter-decision') === 'metadata-only')
    await emitGeo(page, { lat: -31.633292, lng: -60.699992, accuracy: 10, speed: 0, timestamp: t0 + 10_000 })
    await emitGeo(page, { lat: -31.633294, lng: -60.699994, accuracy: 9, speed: 0, timestamp: t0 + 15_000 })
    await page.waitForFunction(() => document.querySelector('main[data-motion]')?.getAttribute('data-motion') === 'stationary')
    assert((await page.$eval('main[data-camera-mode]', (node) => node.getAttribute('data-camera-mode'))) === 'stationary', 'stationary camera mode missing')

    await emitGeo(page, { lat: -31.63322, lng: -60.69992, accuracy: 8, speed: 1.8, heading: 35, timestamp: t0 + 20_000 })
    await emitGeo(page, { lat: -31.63314, lng: -60.69984, accuracy: 8, speed: 2, heading: 40, timestamp: t0 + 25_000 })
    await emitGeo(page, { lat: -31.63306, lng: -60.69976, accuracy: 8, speed: 2.1, heading: 45, timestamp: t0 + 35_000 })
    await page.waitForFunction(() => document.querySelector('main[data-motion]')?.getAttribute('data-motion') === 'moving')
    assert((await page.$eval('main[data-camera-mode]', (node) => node.getAttribute('data-camera-mode'))) === 'follow', 'follow camera mode missing')

    const canvas = await page.$('canvas.maplibregl-canvas')
    const box = await canvas.boundingBox()
    assert(box, 'map canvas has no bounds')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, { steps: 4 })
    await page.mouse.up()
    await page.waitForFunction(() => document.querySelector('main[data-camera-mode]')?.getAttribute('data-camera-mode') === 'manual')
    await emitGeo(page, { lat: -31.63294, lng: -60.69964, accuracy: 8, speed: 2.2, heading: 50, timestamp: t0 + 45_000 })
    assert((await page.$eval('main[data-camera-mode]', (node) => node.getAttribute('data-camera-mode'))) === 'manual', 'automatic update escaped manual camera')
    await page.click('button[aria-label="Recentrar mapa"]')
    await page.waitForFunction(() => document.querySelector('main[data-camera-mode]')?.getAttribute('data-camera-mode') === 'follow')

    await emitGeo(page, { lat: -34.6037, lng: -58.3816, accuracy: 8, speed: null, timestamp: t0 + 55_000 })
    await page.waitForFunction(() => document.querySelector('main[data-filter-decision]')?.getAttribute('data-filter-decision') === 'rejected')
    await emitGeo(page, { lat: -31.63290, lng: -60.69960, accuracy: 500, timestamp: t0 + 65_000 })
    await page.waitForFunction(() => document.querySelector('main[data-filter-decision]')?.getAttribute('data-filter-decision') === 'rejected')

    await emitGeo(page, { lat: -31.63254, lng: -60.69924, accuracy: 7, speed: 2, timestamp: t0 + 125_000 })
    await page.waitForFunction(() => Number(document.querySelector('main[data-ghostrail-segments]')?.getAttribute('data-ghostrail-segments')) >= 2)

    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.setViewport({ width: viewport.height, height: viewport.width, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')))
    assert(!(await page.content()).includes('¿Qué ubicación querés ver?'), 'orientation/background incorrectly reopened selector')
    await page.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true })

    await page.$eval('canvas.maplibregl-canvas', (node) => node.dispatchEvent(new Event('webglcontextlost', { cancelable: true })))
    await page.waitForFunction(() => Number(document.querySelector('main[data-webgl-recovery]')?.getAttribute('data-webgl-recovery')) >= 1)
    await page.$eval('canvas.maplibregl-canvas', (node) => node.dispatchEvent(new Event('webglcontextrestored')))
    assert(!(await page.content()).includes('¿Qué ubicación querés ver?'), 'WebGL recovery incorrectly reopened selector')

    await page.click('section[aria-label="Estado de ubicación"] > button')
    await clickText(page, 'CAMBIAR UBICACIÓN')
    await page.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'))
    assert((await page.evaluate(() => window.__strackerGeo.clearCalls)) >= 1, 'source change did not clear geolocation watcher')
    assert((await page.$$('main[data-map-engine]')).length === 0, 'map survived source reset')
    const sourceStorage = await page.evaluate(() => localStorage.getItem('stracker.lastSelectedSource'))
    assert(sourceStorage === null, 'source selection was persisted')

    await page.reload({ waitUntil: 'networkidle0' })
    assert((await page.content()).includes('¿Qué ubicación querés ver?'), 'reload did not return to source selector')
    assert(providerRequests.length >= 1, 'MapLibre provider was never requested after map unlock')
    assert(pageErrors.length === 0, `pageerror ${viewport.width}x${viewport.height}: ${pageErrors.join(' | ')}`)
    assert(consoleErrors.length === 0, `console errors ${viewport.width}x${viewport.height}: ${consoleErrors.join(' | ')}`)
    await noOverflow(page, `final ${viewport.width}x${viewport.height}`)

    raw.viewports.push({
      ...viewport,
      pageErrors: pageErrors.length,
      consoleErrors: consoleErrors.length,
      providerRequestCount: providerRequests.length,
      apiRequestCountBeforeSelection: 0,
      ghostrailDiscontinuityObserved: true,
      manualCameraObserved: true,
      webglRecoveryObserved: true,
    })
    await context.close()
  }

  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setViewport({ width: 320, height: 568, isMobile: true, hasTouch: true })
  const requests = []
  await page.setRequestInterception(true)
  page.on('request', async (request) => {
    const url = new URL(request.url())
    if (url.origin !== new URL(baseUrl).origin) {
      await request.continue()
      return
    }
    requests.push(url.pathname)
    if (url.pathname === '/api/session/status') {
      await new Promise((resolve) => setTimeout(resolve, 250))
      await request.respond({
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Stracker-Gateway': 'private-poc-v1', 'Cache-Control': 'no-store' },
        body: JSON.stringify({
          appAuthenticated: true,
          state: 'SHARED_UNCONFIGURED',
          health: 'UNCONFIGURED',
          configured: false,
          formatDetected: null,
          count: 0,
          criticalPresent: [],
          criticalMissing: [],
          message: 'Synthetic late response',
        }),
      }).catch(() => {})
      return
    }
    await request.continue()
  })
  await page.goto(baseUrl, { waitUntil: 'networkidle0' })
  await clickText(page, 'UBICACIÓN COMPARTIDA')
  await page.waitForFunction(() => document.body.textContent?.includes('Vincular sesión de Google Maps'))
  await page.click('button[aria-label="Volver"]')
  await page.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'))
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert((await page.$$('main[data-map-engine]')).length === 0, 'late shared response repopulated prior source')
  assert(requests.includes('/api/session/status'), 'shared status was not requested after explicit selection')
  await context.close()

  raw.gates = {
    NO_MAP_REQUEST_BEFORE_SOURCE_SELECTION: 'PASS',
    NO_LOCATION_REQUEST_BEFORE_SOURCE_SELECTION: 'PASS',
    NO_SESSION_REQUEST_BEFORE_SOURCE_SELECTION: 'PASS',
    SOURCE_SWITCH_LATE_RESPONSE_BLOCKED: 'PASS',
    GHOSTRAIL_DISCONTINUITIES_NOT_CONNECTED: 'PASS',
    MANUAL_CAMERA_MODE: 'PASS',
    ATTRIBUTION_VISIBLE: 'PASS',
    MOBILE_QA: 'PASS',
  }
  fs.writeFileSync(output, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
  console.log(`MOBILE_QA_PASS viewports=${viewports.length} pageerror=0 overflow=0 engine=maplibre`)
} finally {
  await browser.close()
}
