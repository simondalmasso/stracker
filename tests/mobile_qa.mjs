import fs from 'node:fs'
import puppeteer from 'puppeteer-core'

const executablePath = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:4173'
const rawOutput = process.env.QA_RAW_OUTPUT || '/tmp/stracker-vector-map-performance.json'
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
        getCurrentPosition() {
          throw new Error('getCurrentPosition is not allowed in STRACKER')
        },
      },
    })
  })
}

async function emitGeo(page, { lat, lng, accuracy = 8, speed = null, heading = null, timestamp }) {
  await page.evaluate((payload) => {
    window.__strackerGeo.emit({
      coords: {
        latitude: payload.lat,
        longitude: payload.lng,
        accuracy: payload.accuracy,
        altitude: null,
        altitudeAccuracy: null,
        heading: payload.heading,
        speed: payload.speed,
      },
      timestamp: payload.timestamp,
    })
  }, { lat, lng, accuracy, speed, heading, timestamp })
}

function validStatus() {
  return {
    appAuthenticated: true,
    state: 'SHARED_READY',
    health: 'VALID',
    configured: true,
    formatDetected: 'synthetic',
    count: 1,
    criticalPresent: ['SYNTHETIC_ONLY'],
    criticalMissing: [],
    message: 'Synthetic fixture only',
  }
}

async function configureSharedApi(page, options = {}) {
  const calls = []
  let statusResolver = null
  await page.setRequestInterception(true)
  page.on('request', async (request) => {
    const url = new URL(request.url())
    if (url.origin !== new URL(baseUrl).origin) {
      await request.continue()
      return
    }
    if (!['/api/session/status', '/api/session/import', '/api/session/delete', '/points'].includes(url.pathname)) {
      await request.continue()
      return
    }
    calls.push({ path: url.pathname, method: request.method() })
    const headers = { 'Content-Type': 'application/json', 'X-Stracker-Gateway': 'private-poc-v1', 'Cache-Control': 'no-store' }
    if (url.pathname === '/api/session/status') {
      if (options.delayStatus) await new Promise((resolve) => { statusResolver = resolve })
      await request.respond({ status: 200, headers, body: JSON.stringify(validStatus()) })
      return
    }
    if (url.pathname === '/api/session/import') {
      await request.respond({ status: 200, headers, body: JSON.stringify({ ...validStatus(), status: 'ok', action: 'import' }) })
      return
    }
    if (url.pathname === '/api/session/delete') {
      await request.respond({ status: 200, headers, body: JSON.stringify({ status: 'ok' }) })
      return
    }
    const now = Date.now()
    const points = options.points || [
      { lat: -31.6333, lng: -60.7000, accuracy: 20, timestamp: new Date(now - 20_000).toISOString() },
      { lat: -31.6331, lng: -60.6998, accuracy: 18, timestamp: new Date(now - 10_000).toISOString() },
      { lat: -31.6329, lng: -60.6996, accuracy: 16, timestamp: new Date(now).toISOString() },
    ]
    await request.respond({
      status: options.pointsStatus || 200,
      headers,
      body: JSON.stringify(options.pointsStatus && options.pointsStatus !== 200 ? { error: 'SYNTHETIC_ERROR', message: 'fixture' } : { points, ghostrail_pts: [], last_update: points.at(-1)?.timestamp || null }),
    })
  })
  return { calls, resolveStatus: () => statusResolver?.() }
}

async function waitForMap(page) {
  await page.waitForSelector('main[data-map-engine="maplibre"] .maplibregl-map', { timeout: 30000 })
  await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 30000 })
}

async function noOverflow(page, label) {
  assert(await page.$eval('body', (body) => body.scrollWidth <= window.innerWidth), `horizontal overflow: ${label}`)
}

async function touchTargets(page, label) {
  const tooSmall = await page.$$eval('button', (buttons) => buttons.filter((button) => {
    const rect = button.getBoundingClientRect()
    return rect.width < 44 || rect.height < 44
  }).map((button) => ({ text: button.textContent, label: button.getAttribute('aria-label') })))
  assert(tooSmall.length === 0, `touch target below 44px at ${label}: ${JSON.stringify(tooSmall)}`)
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
  ],
})

const raw = {
  generatedAt: new Date().toISOString(),
  engine: 'maplibre',
  provider: 'openfreemap-openstreetmap',
  viewports: [],
  physicalDevice: 'NOT_EXECUTED_ENV_BLOCKED',
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
    const sessionRequests = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('Failed to load resource')) consoleErrors.push(message.text())
    })
    page.on('request', (request) => {
      const url = request.url()
      if (url.includes('openfreemap.org') || url.includes('openstreetmap.org')) providerRequests.push(url)
      const path = new URL(url).pathname
      if (path === '/points' || path.startsWith('/api/session/')) sessionRequests.push(path)
    })

    const startedAt = Date.now()
    await page.goto(baseUrl, { waitUntil: 'networkidle0' })
    await noOverflow(page, `selector ${viewport.width}x${viewport.height}`)
    await touchTargets(page, `selector ${viewport.width}x${viewport.height}`)
    assert((await page.$$eval('button', (buttons) => buttons.length)) === 2, 'selector must show exactly two primary choices')
    assert((await page.content()).includes('MI UBICACIÓN'), 'my location option missing')
    assert((await page.content()).includes('UBICACIÓN COMPARTIDA'), 'shared location option missing')
    assert((await page.$$('main[data-map-engine]')).length === 0, 'map must not exist before source selection')
    assert(providerRequests.length === 0, 'map provider request occurred before source selection')
    assert(sessionRequests.length === 0, 'session request occurred before source selection')
    assert((await page.evaluate(() => window.__strackerGeo.watchCalls)) === 0, 'geolocation watch started before source selection')

    await clickText(page, 'MI UBICACIÓN')
    await page.waitForFunction(() => document.body.textContent?.includes('PERMITIR UBICACIÓN'))
    assert(providerRequests.length === 0, 'map provider request occurred before location permission')
    assert((await page.evaluate(() => window.__strackerGeo.watchCalls)) === 0, 'watch started before explicit permission action')
    await clickText(page, 'PERMITIR UBICACIÓN')
    assert((await page.evaluate(() => window.__strackerGeo.watchCalls)) === 1, 'watchPosition was not started exactly once')

    const t0 = Date.now()
    await emitGeo(page, { lat: -31.6333, lng: -60.7000, timestamp: t0 })
    await waitForMap(page)
    await page.waitForFunction(() => document.querySelector('main[data-health]')?.getAttribute('data-health') === 'receiving')
    assert(sessionRequests.length === 0, 'my-location mode called shared backend')
    assert((await page.$eval('main[data-map-engine]', (node) => node.getAttribute('data-map-engine'))) === 'maplibre', 'wrong final map engine')
    assert(await page.$eval('[aria-label="Atribución del mapa"]', (node) => {
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    }), 'attribution must be visible')

    await emitGeo(page, { lat: -31.63331, lng: -60.70001, accuracy: 18, speed: 0, timestamp: t0 + 5_000 })
    await emitGeo(page, { lat: -31.63330, lng: -60.70000, accuracy: 17, speed: 0, timestamp: t0 + 10_000 })
    await emitGeo(page, { lat: -31.63331, lng: -60.70000, accuracy: 16, speed: 0, timestamp: t0 + 15_000 })
    await page.waitForFunction(() => document.querySelector('main[data-motion]')?.getAttribute('data-motion') === 'stationary')
    assert((await page.$eval('main[data-camera-mode]', (node) => node.getAttribute('data-camera-mode'))) === 'stationary', 'stationary camera mode missing')

    await emitGeo(page, { lat: -31.63318, lng: -60.69988, accuracy: 8, speed: 2.1, heading: 45, timestamp: t0 + 25_000 })
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

    await emitGeo(page, { lat: -31.63282, lng: -60.69952, accuracy: 7, speed: 2, timestamp: t0 + 125_000 })
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

    const resources = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => ({
      name: entry.name,
      duration: entry.duration,
      transferSize: entry.transferSize || 0,
      encodedBodySize: entry.encodedBodySize || 0,
    })))
    raw.viewports.push({
      ...viewport,
      elapsedMs: Date.now() - startedAt,
      providerRequestCount: providerRequests.length,
      sessionRequestCount: sessionRequests.length,
      resourceCount: resources.length,
      transferredBytes: resources.reduce((total, item) => total + item.transferSize, 0),
      pageErrors: pageErrors.length,
      consoleErrors: consoleErrors.length,
    })
    await context.close()
  }

  const lateContext = await browser.createBrowserContext()
  const latePage = await lateContext.newPage()
  await latePage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await installSyntheticGeolocation(latePage)
  const delayed = await configureSharedApi(latePage, { delayStatus: true })
  await latePage.goto(baseUrl, { waitUntil: 'networkidle0' })
  await clickText(latePage, 'UBICACIÓN COMPARTIDA')
  await latePage.waitForFunction(() => document.body.textContent?.includes('Vincular sesión de Google Maps'))
  await latePage.click('button[aria-label="Volver"]')
  await latePage.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'))
  await clickText(latePage, 'MI UBICACIÓN')
  delayed.resolveStatus()
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert((await latePage.content()).includes('PERMITIR UBICACIÓN'), 'late shared response repopulated previous source')
  assert((await latePage.$$('main[data-location-source="google-shared"]')).length === 0, 'late response rendered shared map')
  await lateContext.close()

  const sharedContext = await browser.createBrowserContext()
  const sharedPage = await sharedContext.newPage()
  await sharedPage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  const sharedApi = await configureSharedApi(sharedPage)
  await sharedPage.goto(baseUrl, { waitUntil: 'networkidle0' })
  assert(sharedApi.calls.length === 0, 'shared API called before source selection')
  await clickText(sharedPage, 'UBICACIÓN COMPARTIDA')
  await waitForMap(sharedPage)
  assert(sharedApi.calls.some((call) => call.path === '/api/session/status'), 'shared status was not requested')
  assert(sharedApi.calls.some((call) => call.path === '/points'), 'shared points were not requested')
  assert((await sharedPage.$eval('main[data-location-source]', (node) => node.getAttribute('data-location-source'))) === 'google-shared', 'shared source map missing')
  await sharedContext.close()

  const reducedContext = await browser.createBrowserContext()
  const reducedPage = await reducedContext.newPage()
  await reducedPage.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await reducedPage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await installSyntheticGeolocation(reducedPage)
  await reducedPage.goto(baseUrl, { waitUntil: 'networkidle0' })
  await clickText(reducedPage, 'MI UBICACIÓN')
  await clickText(reducedPage, 'PERMITIR UBICACIÓN')
  await emitGeo(reducedPage, { lat: -31.6333, lng: -60.7000, timestamp: Date.now() })
  await waitForMap(reducedPage)
  assert(await reducedPage.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), 'reduced motion was not active')
  await reducedContext.close()

  fs.writeFileSync(rawOutput, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 })
  console.log('NO_MAP_REQUEST_BEFORE_SOURCE_SELECTION=PASS')
  console.log('NO_LOCATION_REQUEST_BEFORE_SOURCE_SELECTION=PASS')
  console.log('NO_SESSION_REQUEST_BEFORE_SOURCE_SELECTION=PASS')
  console.log('SOURCE_SWITCH_LATE_RESPONSE_BLOCKED=PASS')
  console.log('GHOSTRAIL_DISCONTINUITIES_NOT_CONNECTED=PASS')
  console.log('MANUAL_CAMERA_MODE=PASS')
  console.log('ATTRIBUTION_VISIBLE=PASS')
  console.log(`MOBILE_QA_PASS viewports=${viewports.length} pageerror=0 overflow=0 touch_targets=pass`)
} finally {
  await browser.close()
}
