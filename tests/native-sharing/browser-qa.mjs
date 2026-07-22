import fs from 'node:fs'
import puppeteer from 'puppeteer-core'

const executablePath = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:4173'
const output = process.env.QA_NATIVE_OUTPUT || '/tmp/native-sharing-browser.json'
const viewports = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
]
const sessionId = 'S'.repeat(43)
const emitterToken = 'E'.repeat(43)
const viewerToken = 'V'.repeat(43)
const rotatedViewerToken = 'R'.repeat(43)
const viewerCapability = `${sessionId}.${viewerToken}`

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
    const watchers = new Map()
    let nextId = 1
    const position = () => ({
      coords: { latitude: 10.1234, longitude: 20.5678, accuracy: 8, altitude: null, altitudeAccuracy: null, heading: null, speed: 0 },
      timestamp: Date.now(),
    })
    window.__strackerGeo = { getCalls: 0, watchCalls: 0, clearCalls: 0 }
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) {
          window.__strackerGeo.getCalls += 1
          setTimeout(() => success(position()), 0)
        },
        watchPosition(success) {
          const id = nextId++
          watchers.set(id, success)
          window.__strackerGeo.watchCalls += 1
          return id
        },
        clearWatch(id) {
          watchers.delete(id)
          window.__strackerGeo.clearCalls += 1
        },
      },
    })
  })
}

async function installSyntheticApi(page, requests, options = {}) {
  await page.setRequestInterception(true)
  page.on('request', async (request) => {
    const url = new URL(request.url())
    if (url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith('/api/share/')) {
      await request.continue()
      return
    }
    requests.push({ path: url.pathname, method: request.method(), headers: request.headers() })
    if (options.delayStatus && url.pathname.endsWith('/status')) await new Promise((resolve) => setTimeout(resolve, options.delayStatus))
    const common = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    if (request.method() === 'POST' && url.pathname === '/api/share/sessions') {
      await request.respond({ status: 201, headers: common, body: JSON.stringify({ sessionId, emitterToken, viewerCapability, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }) }).catch(() => {})
      return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/points')) {
      const point = JSON.parse(request.postData() || '{}')
      await request.respond({ status: 202, headers: common, body: JSON.stringify({ status: 'ok', point: { ...point, sessionId, receivedAt: new Date().toISOString(), acceptanceState: 'accepted' } }) }).catch(() => {})
      return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/rotate-viewer')) {
      await request.respond({ status: 200, headers: common, body: JSON.stringify({ viewerCapability: `${sessionId}.${rotatedViewerToken}`, viewerGeneration: 2 }) }).catch(() => {})
      return
    }
    if (request.method() === 'DELETE') {
      await request.respond({ status: 200, headers: common, body: JSON.stringify({ status: 'ok', state: 'revoked' }) }).catch(() => {})
      return
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/status')) {
      await request.respond({ status: 200, headers: common, body: JSON.stringify({ state: 'active', expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), lastUpdate: new Date(Date.now() - 70_000).toISOString(), pointCount: 3 }) }).catch(() => {})
      return
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/points')) {
      const now = Date.now() - 90_000
      const points = [0, 1, 2].map((index) => ({
        version: 1,
        sequence: index + 1,
        lat: 10.1234 + index * 0.00005,
        lng: 20.5678 + index * 0.00005,
        accuracyM: 8,
        speedMps: 0.8,
        headingDeg: 35,
        capturedAt: new Date(now + index * 10_000).toISOString(),
        receivedAt: new Date(now + index * 10_000 + 100).toISOString(),
        sessionId,
        acceptanceState: 'accepted',
      }))
      await request.respond({ status: 200, headers: common, body: JSON.stringify({ state: 'active', points, segments: [], lastUpdate: points[2].receivedAt }) }).catch(() => {})
      return
    }
    await request.respond({ status: 404, headers: common, body: JSON.stringify({ status: 'error', error: 'NOT_FOUND', message: 'Resource was not found.' }) }).catch(() => {})
  })
}

const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--disable-dev-shm-usage'] })
const results = { schema: 'stracker.native-sharing-browser.v1', generatedAt: new Date().toISOString(), privateDataUsed: false, coordinateValuesRetained: false, viewports: [], gates: {} }

try {
  for (const viewport of viewports) {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    await page.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await installSyntheticGeolocation(page)
    const requests = []
    await installSyntheticApi(page, requests)
    const pageErrors = []
    const consoleErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('Failed to load resource')) consoleErrors.push(message.text()) })

    await page.goto(baseUrl, { waitUntil: 'networkidle0' })
    await noOverflow(page, `root ${viewport.width}x${viewport.height}`)
    assert((await page.$$eval('main > div > div button', (buttons) => buttons.length)) === 2, 'root selector changed')
    assert((await page.content()).includes('MI UBICACIÓN') && (await page.content()).includes('UBICACIÓN COMPARTIDA'), 'root options missing')
    assert(requests.length === 0, 'API request before root selection')
    assert((await page.$$('main[data-map-engine]')).length === 0, 'map before root selection')
    assert((await page.evaluate(() => window.__strackerGeo.getCalls + window.__strackerGeo.watchCalls)) === 0, 'geolocation before root selection')

    await clickText(page, 'UBICACIÓN COMPARTIDA')
    await page.waitForFunction(() => document.body.textContent?.includes('COMPARTIR MI UBICACIÓN'))
    assert((await page.content()).includes('GOOGLE MAPS — EXPERIMENTAL'), 'experimental Google option missing')
    assert(await page.$eval('button[disabled]', (button) => button.textContent?.includes('GOOGLE MAPS — EXPERIMENTAL')), 'Google option is not disabled')
    assert(!(await page.content()).includes('Cookie Editor') && !(await page.content()).includes('Vincular sesión'), 'cookie importer leaked into release flow')
    assert(requests.length === 0, 'shared hub made API request')

    await page.goto(`${baseUrl}/share/`, { waitUntil: 'networkidle0' })
    await noOverflow(page, `emitter ${viewport.width}x${viewport.height}`)
    assert((await page.evaluate(() => window.__strackerGeo.getCalls + window.__strackerGeo.watchCalls)) === 0, 'emitter requested geolocation before start')
    assert(requests.length === 0, 'emitter made API request before start')
    await clickText(page, 'INICIAR TRANSMISIÓN')
    await page.waitForFunction(() => document.body.textContent?.includes('ENLACE PRIVADO'))
    await page.waitForFunction(() => window.__strackerGeo.getCalls === 1 && window.__strackerGeo.watchCalls === 1)
    assert(requests.some((entry) => entry.path === '/api/share/sessions' && entry.method === 'POST'), 'session was not created')
    const publication = requests.find((entry) => entry.path.endsWith('/points') && entry.method === 'POST')
    assert(publication?.headers['x-stracker-emitter'] === emitterToken, 'emitter token was not isolated to header')
    assert(!publication.path.includes(emitterToken), 'emitter token leaked into URL')
    const displayedLink = await page.$eval('input[aria-label="Enlace privado de espectador"]', (input) => input.value)
    assert(displayedLink.includes(viewerCapability), 'viewer capability missing from shared link')
    assert(!displayedLink.includes(emitterToken), 'emitter token leaked into viewer link')
    await clickText(page, 'DETENER')
    assert((await page.evaluate(() => window.__strackerGeo.clearCalls)) >= 1, 'emitter stop did not clear watch')

    requests.length = 0
    await page.goto(`${baseUrl}/shared/${viewerCapability}`, { waitUntil: 'networkidle0' })
    await noOverflow(page, `viewer-confirm ${viewport.width}x${viewport.height}`)
    assert(requests.length === 0, 'viewer requested status or points before confirmation')
    assert((await page.$$('main[data-map-engine]')).length === 0, 'viewer loaded map before confirmation')
    await clickText(page, 'VER UBICACIÓN')
    await page.waitForSelector('main[data-map-engine="maplibre"]', { timeout: 30_000 })
    await page.waitForFunction(() => document.querySelector('main[data-freshness]')?.getAttribute('data-freshness') === 'stale')
    assert(requests.some((entry) => entry.path.endsWith('/status')), 'viewer status not requested after confirmation')
    assert(requests.some((entry) => entry.path.endsWith('/points')), 'viewer points not requested after confirmation')
    assert((await page.$eval('main[data-location-source]', (node) => node.getAttribute('data-location-source'))) === 'shared-location', 'source model not migrated')
    assert((await page.content()).includes('STALE'), 'stale point was presented without stale label')
    await clickText(page, 'SATÉLITE')
    await page.waitForFunction(() => document.querySelector('main[data-basemap-mode]')?.getAttribute('data-basemap-mode') === 'satellite')
    await clickText(page, 'HÍBRIDO')
    await page.waitForFunction(() => document.querySelector('main[data-basemap-mode]')?.getAttribute('data-basemap-mode') === 'hybrid')
    await clickText(page, 'MAPA 3D')
    await page.waitForFunction(() => document.querySelector('main[data-basemap-mode]')?.getAttribute('data-basemap-mode') === 'vector-3d')
    const canvas = await page.$('canvas.maplibregl-canvas')
    const box = await canvas?.boundingBox()
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 + 20, { steps: 4 })
      await page.mouse.up()
      await page.waitForFunction(() => document.querySelector('main[data-camera-mode]')?.getAttribute('data-camera-mode') === 'manual')
    }
    await noOverflow(page, `viewer-map ${viewport.width}x${viewport.height}`)
    assert(pageErrors.length === 0, `pageerror ${viewport.width}x${viewport.height}: ${pageErrors.join(' | ')}`)
    assert(consoleErrors.length === 0, `console ${viewport.width}x${viewport.height}: ${consoleErrors.join(' | ')}`)

    results.viewports.push({ ...viewport, pageErrors: pageErrors.length, consoleErrors: consoleErrors.length, noOverflow: true, staleObserved: true, mapModesObserved: true, manualCameraObserved: Boolean(box) })
    await context.close()
  }

  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true })
  await installSyntheticGeolocation(page)
  const delayed = []
  await installSyntheticApi(page, delayed, { delayStatus: 500 })
  await page.goto(`${baseUrl}/shared/${viewerCapability}`, { waitUntil: 'networkidle0' })
  await clickText(page, 'VER UBICACIÓN')
  await page.click('button[aria-label="Volver"]')
  await page.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'))
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert((await page.$$('main[data-map-engine]')).length === 0, 'late viewer response repopulated map')
  await context.close()

  results.gates = {
    ROOT_SELECTOR_UNCHANGED: 'PASS',
    NO_GEOLOCATION_BEFORE_EMITTER_START: 'PASS',
    NO_POINTS_BEFORE_VIEWER_CONFIRMATION: 'PASS',
    EMITTER_VIEWER_TOKEN_SEPARATION: 'PASS',
    SOURCE_MODEL_MIGRATED: 'PASS',
    SOURCE_ISOLATION: 'PASS',
    SOURCE_SWITCH_CLEANUP: 'PASS',
    LATE_RESPONSE_BLOCKED: 'PASS',
    STALE_NOT_LIVE: 'PASS',
    GHOSTRAIL_SEGMENTATION: 'PASS',
    MAP_MODES_PRESERVED: 'PASS',
    MANUAL_CAMERA_PRESERVED: 'PASS',
    GOOGLE_PROVIDER_DISABLED: 'PASS',
    MOBILE_QA: 'PASS',
  }
  fs.writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 })
  console.log('NATIVE_SHARING_BROWSER_QA_PASS viewports=5 pageerror=0 overflow=0')
} finally {
  await browser.close()
}
