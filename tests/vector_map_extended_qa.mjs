import fs from 'node:fs'
import puppeteer from 'puppeteer-core'

const executablePath = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:4173'
const output = process.env.QA_EXTENDED_OUTPUT || '/tmp/stracker-vector-map-extended.json'

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

async function startMyLocation(page) {
  await page.goto(baseUrl, { waitUntil: 'networkidle0' })
  await clickText(page, 'MI UBICACIÓN')
  await clickText(page, 'PERMITIR UBICACIÓN')
  await emitGeo(page, { lat: -31.6333, lng: -60.7, accuracy: 3, timestamp: Date.now() })
  await page.waitForSelector('main[data-map-engine="maplibre"]', { timeout: 30000 })
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

const result = {
  schema: 'stracker.vector-map-extended-qa.v1',
  generatedAt: new Date().toISOString(),
  coordinateValuesRetained: false,
  providerDegradation: null,
  sharedNoInterpolation: null,
  reducedMotion: null,
  memoryBound: null,
  gates: {},
}

try {
  {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await installSyntheticGeolocation(page)
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      if (new URL(request.url()).hostname === 'tiles.openfreemap.org') {
        await request.respond({ status: 503, contentType: 'text/plain', body: 'synthetic provider failure' })
      } else {
        await request.continue()
      }
    })
    await startMyLocation(page)
    await page.waitForSelector('main[data-map-provider="degraded"]', { timeout: 30000 })
    const honestBanner = await page.$eval('[role="status"]', (node) => node.textContent?.includes('MAPA DEGRADADO'))
    assert(honestBanner, 'provider degradation banner missing')
    assert(!(await page.content()).includes('¿Qué ubicación querés ver?'), 'provider degradation reopened selector')
    result.providerDegradation = { state: 'degraded', bannerVisible: true, selectorReopened: false }
    result.gates.PROVIDER_FAILURE_DEGRADES_HONESTLY = 'PASS'
    await context.close()
  }

  {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    const apiCalls = []
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      const url = new URL(request.url())
      if (url.origin !== new URL(baseUrl).origin) {
        await request.continue()
        return
      }
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
      await request.continue()
    })
    await page.goto(baseUrl, { waitUntil: 'networkidle0' })
    await clickText(page, 'UBICACIÓN COMPARTIDA')
    await page.waitForSelector('main[data-location-source="google-shared"]', { timeout: 30000 })
    await page.waitForFunction(() => Number(document.querySelector('main[data-ghostrail-points]')?.getAttribute('data-ghostrail-points')) === 3)
    const renderedPoints = await page.$eval('main[data-ghostrail-points]', (node) => Number(node.getAttribute('data-ghostrail-points')))
    assert(renderedPoints === 3, `shared pipeline interpolated or dropped accepted fixture points: ${renderedPoints}`)
    result.sharedNoInterpolation = { inputPoints: 3, renderedAcceptedPoints: renderedPoints, apiPaths: [...new Set(apiCalls)].sort() }
    result.gates.SHARED_POLLING_NO_INTERPOLATION = 'PASS'
    await context.close()
  }

  {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await installSyntheticGeolocation(page)
    await startMyLocation(page)
    await page.waitForFunction(() => document.querySelector('main[data-reduced-motion]')?.getAttribute('data-reduced-motion') === 'true')
    const animation = await page.$eval('main[data-camera-animation]', (node) => node.getAttribute('data-camera-animation'))
    assert(animation === 'off', 'reduced-motion camera animation remained enabled')
    result.reducedMotion = { mediaMatched: true, cameraAnimation: 'off' }
    result.gates.REDUCED_MOTION = 'PASS'
    await context.close()
  }

  {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
    await installSyntheticGeolocation(page)
    await startMyLocation(page)
    const client = await page.createCDPSession()
    await client.send('HeapProfiler.enable')
    await client.send('HeapProfiler.collectGarbage')
    const heapBefore = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null)
    const start = Date.now()
    await page.evaluate((baseTimestamp) => {
      for (let index = 1; index <= 620; index += 1) {
        window.__strackerGeo.emit({
          coords: {
            latitude: -31.6333 + index * 0.00005,
            longitude: -60.7 + index * 0.00005,
            accuracy: 1,
            altitude: null,
            altitudeAccuracy: null,
            heading: 45,
            speed: 1.2,
          },
          timestamp: baseTimestamp + index * 5_000,
        })
      }
    }, start)
    await page.waitForFunction(() => Number(document.querySelector('main[data-ghostrail-points]')?.getAttribute('data-ghostrail-points')) === 600, { timeout: 30000 })
    await client.send('HeapProfiler.collectGarbage')
    const heapAfter = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null)
    assert(heapBefore !== null && heapAfter !== null, 'precise memory metrics unavailable')
    const heapGrowthBytes = Math.max(0, heapAfter - heapBefore)
    const retainedPoints = await page.$eval('main[data-ghostrail-points]', (node) => Number(node.getAttribute('data-ghostrail-points')))
    assert(retainedPoints === 600, `GhostRail memory cap not enforced: ${retainedPoints}`)
    assert(heapGrowthBytes <= 30_000_000, `heap growth exceeded budget: ${heapGrowthBytes}`)
    result.memoryBound = { emittedReadings: 620, retainedGhostrailPoints: retainedPoints, heapGrowthBytes, budgetBytes: 30_000_000 }
    result.gates.NO_UNBOUNDED_MEMORY_GROWTH = 'PASS'
    await context.close()
  }

  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  console.log('PROVIDER_FAILURE_DEGRADES_HONESTLY=PASS')
  console.log('SHARED_POLLING_NO_INTERPOLATION=PASS')
  console.log('REDUCED_MOTION=PASS')
  console.log('NO_UNBOUNDED_MEMORY_GROWTH=PASS')
} finally {
  await browser.close()
}
