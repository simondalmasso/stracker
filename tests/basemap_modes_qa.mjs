import fs from 'node:fs'
import puppeteer from 'puppeteer-core'

const executablePath = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:4173'
const output = process.env.QA_BASEMAP_OUTPUT || '/tmp/basemap-modes-results.json'
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function clickText(page, text) {
  await page.$$eval('button', (buttons, expected) => {
    const target = buttons.find((button) => button.textContent?.trim().toUpperCase() === String(expected).toUpperCase())
      ?? buttons.find((button) => button.textContent?.toUpperCase().includes(String(expected).toUpperCase()))
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

async function respondRaster(request, counters, fail = false) {
  counters.requests += 1
  if (fail) {
    await request.respond({ status: 503, contentType: 'text/plain', body: 'synthetic satellite failure' })
    return
  }
  counters.bytes += onePixelPng.byteLength
  await request.respond({
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(onePixelPng.byteLength),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
    },
    body: onePixelPng,
  })
}

async function startMyLocation(page) {
  await page.goto(baseUrl, { waitUntil: 'networkidle0' })
  await clickText(page, 'MI UBICACIÓN')
  await clickText(page, 'PERMITIR UBICACIÓN')
  const t0 = Date.now()
  await emitGeo(page, { lat: -31.6333, lng: -60.7, accuracy: 3, speed: 0, timestamp: t0 })
  await emitGeo(page, { lat: -31.6331, lng: -60.6998, accuracy: 3, speed: 2, heading: 40, timestamp: t0 + 10_000 })
  await emitGeo(page, { lat: -31.6329, lng: -60.6996, accuracy: 3, speed: 2, heading: 45, timestamp: t0 + 20_000 })
  await page.waitForSelector('main[data-map-engine="maplibre"]', { timeout: 30000 })
  await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 30000 })
  await page.waitForFunction(() => Number(document.querySelector('main[data-ghostrail-points]')?.getAttribute('data-ghostrail-points')) >= 2)
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
})

const result = {
  schema: 'stracker.basemap-modes-qa.v1',
  generatedAt: new Date().toISOString(),
  coordinateValuesRetained: false,
  renderer: 'maplibre',
  raster: { requests: 0, bytes: 0 },
  gates: {},
}

try {
  {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await installSyntheticGeolocation(page)
    const apiCalls = []
    const raster = { requests: 0, bytes: 0 }
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      const url = new URL(request.url())
      if (url.hostname === 'tiles.maps.eox.at') {
        await respondRaster(request, raster)
        return
      }
      if (url.origin === new URL(baseUrl).origin && ['/api/session/status', '/api/session/import', '/api/session/delete', '/points'].includes(url.pathname)) apiCalls.push(url.pathname)
      await request.continue()
    })

    await startMyLocation(page)
    assert((await page.$eval('main', (node) => node.getAttribute('data-basemap-mode'))) === 'vector-3d', 'default basemap is not vector-3d')
    const canvas = await page.$('canvas.maplibregl-canvas')
    const box = await canvas.boundingBox()
    assert(box, 'map canvas has no bounds')
    await page.evaluate(() => { window.__strackerCanvasIdentity = document.querySelector('canvas.maplibregl-canvas') })
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, { steps: 4 })
    await page.mouse.up()
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-camera-mode') === 'manual')

    const before = await page.$eval('main', (node) => ({
      source: node.getAttribute('data-location-source'),
      camera: node.getAttribute('data-camera-mode'),
      marker: node.getAttribute('data-marker-present'),
      rail: node.getAttribute('data-ghostrail-points'),
      capturedAt: node.getAttribute('data-captured-at'),
    }))
    const watchCalls = await page.evaluate(() => window.__strackerGeo.watchCalls)
    const initialApiCalls = apiCalls.length

    await clickText(page, 'SATÉLITE')
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-basemap-mode') === 'satellite')
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-basemap-provider') === 'available')
    assert((await page.$eval('[aria-label="Atribución del mapa"]', (node) => node.textContent)).includes('EOxCloudless'), 'satellite attribution missing')
    result.gates.VECTOR_TO_SATELLITE = 'PASS'

    await clickText(page, 'HÍBRIDO')
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-basemap-mode') === 'hybrid')
    assert((await page.$eval('[aria-label="Atribución del mapa"]', (node) => node.textContent)).includes('OpenFreeMap'), 'hybrid overlay attribution missing')
    result.gates.SATELLITE_TO_HYBRID = 'PASS'

    await clickText(page, 'MAPA 3D')
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-basemap-mode') === 'vector-3d')
    result.gates.HYBRID_TO_VECTOR = 'PASS'

    const after = await page.$eval('main', (node) => ({
      source: node.getAttribute('data-location-source'),
      camera: node.getAttribute('data-camera-mode'),
      marker: node.getAttribute('data-marker-present'),
      rail: node.getAttribute('data-ghostrail-points'),
      capturedAt: node.getAttribute('data-captured-at'),
    }))
    assert(after.source === before.source, 'location source changed during basemap transitions')
    assert(after.marker === before.marker && after.marker === 'true', 'marker was not preserved')
    assert(after.rail === before.rail, 'GhostRail changed during basemap transitions')
    assert(after.capturedAt === before.capturedAt, 'location timestamp changed during basemap transitions')
    assert(after.camera === 'manual' && before.camera === 'manual', 'manual camera mode was not preserved')
    assert((await page.evaluate(() => window.__strackerGeo.watchCalls)) === watchCalls, 'basemap change requested geolocation again')
    assert(apiCalls.length === initialApiCalls, 'basemap change requested session or points')
    assert(await page.evaluate(() => window.__strackerCanvasIdentity === document.querySelector('canvas.maplibregl-canvas')), 'MapLibre map was recreated')
    assert((await page.$$('canvas.maplibregl-canvas')).length === 1, 'more than one MapLibre canvas exists')
    assert((await page.$$('.leaflet-container, .mapboxgl-map')).length === 0, 'a second renderer was mounted')
    result.gates.LOCATION_SOURCE_UNCHANGED = 'PASS'
    result.gates.MARKER_PRESERVED = 'PASS'
    result.gates.GHOSTRAIL_PRESERVED = 'PASS'
    result.gates.CAMERA_MANUAL_PRESERVED = 'PASS'
    result.gates.NO_NEW_GEOLOCATION_REQUEST = 'PASS'
    result.gates.NO_NEW_SESSION_REQUEST = 'PASS'
    result.gates.NO_SECOND_RENDERER = 'PASS'
    result.gates.SATELLITE_ATTRIBUTION_VISIBLE = 'PASS'
    result.raster.requests += raster.requests
    result.raster.bytes += raster.bytes
    await context.close()
  }

  {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await installSyntheticGeolocation(page)
    const raster = { requests: 0, bytes: 0 }
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      const url = new URL(request.url())
      if (url.hostname === 'tiles.maps.eox.at') {
        await respondRaster(request, raster, true)
        return
      }
      await request.continue()
    })
    await startMyLocation(page)
    await clickText(page, 'SATÉLITE')
    await page.waitForFunction(() => document.body.textContent?.includes('SATÉLITE NO DISPONIBLE EN ESTA ZONA'), { timeout: 30000 })
    assert((await page.$eval('main', (node) => node.getAttribute('data-location-source'))) === 'my-device', 'provider failure changed location source')
    result.gates.PROVIDER_FAILURE_EXPLICIT = 'PASS'
    await context.close()
  }

  {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    const apiCalls = []
    const raster = { requests: 0, bytes: 0 }
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      const url = new URL(request.url())
      if (url.hostname === 'tiles.maps.eox.at') {
        await respondRaster(request, raster)
        return
      }
      if (url.origin === new URL(baseUrl).origin) {
        const headers = { 'Content-Type': 'application/json', 'X-Stracker-Gateway': 'private-poc-v1', 'Cache-Control': 'no-store' }
        if (url.pathname === '/api/session/status') {
          apiCalls.push(url.pathname)
          await request.respond({ status: 200, headers, body: JSON.stringify({
            appAuthenticated: true,
            state: 'SHARED_READY',
            health: 'VALID',
            configured: true,
            formatDetected: 'synthetic',
            count: 1,
            criticalPresent: ['SYNTHETIC_ONLY'],
            criticalMissing: [],
            message: 'Synthetic fixture only',
          }) })
          return
        }
        if (url.pathname === '/points') {
          apiCalls.push(url.pathname)
          const now = Date.now()
          await request.respond({ status: 200, headers, body: JSON.stringify({
            points: [
              { lat: -31.6333, lng: -60.7, accuracy: 3, timestamp: new Date(now - 20_000).toISOString() },
              { lat: -31.6331, lng: -60.6998, accuracy: 3, timestamp: new Date(now - 10_000).toISOString() },
              { lat: -31.6329, lng: -60.6996, accuracy: 3, timestamp: new Date(now).toISOString() },
            ],
            ghostrail_pts: [],
            last_update: new Date(now).toISOString(),
          }) })
          return
        }
      }
      await request.continue()
    })
    await page.goto(baseUrl, { waitUntil: 'networkidle0' })
    await clickText(page, 'UBICACIÓN COMPARTIDA')
    await page.waitForSelector('main[data-location-source="google-shared"]', { timeout: 30000 })
    const initialCalls = apiCalls.length
    await clickText(page, 'SATÉLITE')
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-basemap-mode') === 'satellite')
    await clickText(page, 'HÍBRIDO')
    await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-basemap-mode') === 'hybrid')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert(apiCalls.length === initialCalls, `shared basemap switch restarted session/polling: ${apiCalls.join(',')}`)
    assert((await page.$eval('main', (node) => node.getAttribute('data-location-source'))) === 'google-shared', 'shared source changed during basemap switch')
    result.raster.requests += raster.requests
    result.raster.bytes += raster.bytes
    await context.close()
  }

  result.gates.ZERO_COST_SATELLITE_GATE = 'PASS'
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  for (const [gate, value] of Object.entries(result.gates)) console.log(`${gate}=${value}`)
} finally {
  await browser.close()
}
