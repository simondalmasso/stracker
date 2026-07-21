import fs from 'node:fs'
import puppeteer from 'puppeteer-core'

const executablePath = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:4173'
const output = process.env.QA_PERFORMANCE_OUTPUT || '/tmp/stracker-vector-map-budget-results.json'
const budgets = JSON.parse(fs.readFileSync('docs/performance/VECTOR_MAP_BUDGETS.json', 'utf8')).budgets

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

try {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await page.evaluateOnNewDocument(() => {
    const callbacks = new Map()
    let nextId = 1
    window.__strackerGeo = {
      emit(position) {
        for (const callback of callbacks.values()) callback(position)
      },
    }
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition(success) {
          const id = nextId++
          callbacks.set(id, success)
          return id
        },
        clearWatch(id) {
          callbacks.delete(id)
        },
      },
    })
  })

  const providerHosts = new Set()
  let vectorProviderRequests = 0
  let vectorProviderContentLengthBytes = 0
  let rasterProviderRequests = 0
  let rasterProviderContentLengthBytes = 0
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.hostname === 'tiles.openfreemap.org') {
      providerHosts.add(url.hostname)
      vectorProviderRequests += 1
    }
    if (url.hostname === 'tiles.maps.eox.at') {
      providerHosts.add(url.hostname)
      rasterProviderRequests += 1
    }
  })
  page.on('response', (response) => {
    const url = new URL(response.url())
    const length = Number(response.headers()['content-length'] || 0)
    if (!Number.isFinite(length) || length <= 0) return
    if (url.hostname === 'tiles.openfreemap.org') vectorProviderContentLengthBytes += length
    if (url.hostname === 'tiles.maps.eox.at') rasterProviderContentLengthBytes += length
  })

  await page.goto(baseUrl, { waitUntil: 'networkidle0' })
  const initialResources = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => ({
    transferSize: entry.transferSize || 0,
    encodedBodySize: entry.encodedBodySize || 0,
  })))
  const initialRouteTransferredBytes = initialResources.reduce((sum, item) => sum + (item.transferSize || item.encodedBodySize || 0), 0)
  assert(initialRouteTransferredBytes <= budgets.initialRouteTransferredBytesMax, `initial route transfer budget exceeded: ${initialRouteTransferredBytes}`)
  assert(vectorProviderRequests === 0, 'vector provider requested before source selection')
  assert(rasterProviderRequests === 0, 'raster provider requested before source selection')

  await clickText(page, 'MI UBICACIÓN')
  await clickText(page, 'PERMITIR UBICACIÓN')
  await page.evaluate(() => {
    window.__strackerGeo.emit({
      coords: {
        latitude: -31.6333,
        longitude: -60.7,
        accuracy: 3,
        altitude: null,
        altitudeAccuracy: null,
        heading: 45,
        speed: 1.5,
      },
      timestamp: Date.now(),
    })
  })
  await page.waitForSelector('main[data-map-provider="available"]', { timeout: 30000 })
  await page.waitForFunction(() => {
    const value = document.querySelector('main[data-map-first-interactive-ms]')?.getAttribute('data-map-first-interactive-ms')
    return value !== null && value !== ''
  }, { timeout: 30000 })

  const adapterMetrics = await page.$eval('main[data-map-engine="maplibre"]', (node) => ({
    firstMapVisibleMs: Number(node.getAttribute('data-map-first-visible-ms')),
    firstMapInteractiveMs: Number(node.getAttribute('data-map-first-interactive-ms')),
    mapRenderRateEstimate: Number(node.getAttribute('data-map-fps')),
    longTasks: Number(node.getAttribute('data-map-long-tasks')),
    longTaskDurationMs: Number(node.getAttribute('data-map-long-task-ms')),
    totalResourceTimingTransferredBytes: Number(node.getAttribute('data-map-transferred-bytes')),
  }))

  const activeRafFps = await page.evaluate(async () => {
    const start = performance.now()
    let frames = 0
    await new Promise((resolve) => {
      const frame = (now) => {
        frames += 1
        if (now - start < 1500) requestAnimationFrame(frame)
        else resolve()
      }
      requestAnimationFrame(frame)
    })
    return Math.round((frames * 1000) / Math.max(1, performance.now() - start))
  })

  assert(adapterMetrics.firstMapVisibleMs > 0 && adapterMetrics.firstMapVisibleMs <= budgets.firstMapVisibleMsMax, `first map visible budget exceeded: ${adapterMetrics.firstMapVisibleMs}`)
  assert(adapterMetrics.firstMapInteractiveMs > 0 && adapterMetrics.firstMapInteractiveMs <= budgets.firstMapInteractiveMsMax, `first map interactive budget exceeded: ${adapterMetrics.firstMapInteractiveMs}`)
  assert(activeRafFps >= budgets.estimatedFpsFloor, `active RAF FPS floor missed: ${activeRafFps}`)
  assert(adapterMetrics.longTasks <= budgets.longTaskCountMax, `long task count exceeded: ${adapterMetrics.longTasks}`)
  assert(adapterMetrics.longTaskDurationMs <= budgets.longTaskDurationMsMax, `long task duration exceeded: ${adapterMetrics.longTaskDurationMs}`)
  assert(vectorProviderRequests <= budgets.mapProviderRequestsFirstViewportMax, `vector provider request budget exceeded: ${vectorProviderRequests}`)
  const vectorProviderBytesObserved = vectorProviderContentLengthBytes
  assert(vectorProviderBytesObserved <= budgets.mapProviderTransferredBytesFirstViewportMax, `vector provider byte budget exceeded: ${vectorProviderBytesObserved}`)

  await clickText(page, 'SATÉLITE')
  await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-basemap-mode') === 'satellite')
  await page.waitForFunction(() => document.querySelector('main')?.getAttribute('data-basemap-provider') === 'available', { timeout: 30000 })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const rasterAdapterMetrics = await page.$eval('main[data-map-engine="maplibre"]', (node) => ({
    rasterResourceCount: Number(node.getAttribute('data-raster-request-count')),
    rasterTransferredBytes: Number(node.getAttribute('data-raster-transferred-bytes')),
  }))
  assert(rasterProviderRequests > 0, 'satellite mode made no raster requests')
  assert(rasterProviderRequests <= budgets.rasterProviderRequestsFirstViewportMax, `raster provider request budget exceeded: ${rasterProviderRequests}`)
  const rasterProviderBytesObserved = Math.max(rasterProviderContentLengthBytes, rasterAdapterMetrics.rasterTransferredBytes)
  assert(rasterProviderBytesObserved > 0, 'satellite raster byte measurement is empty')
  assert(rasterProviderBytesObserved <= budgets.rasterProviderTransferredBytesFirstViewportMax, `raster provider byte budget exceeded: ${rasterProviderBytesObserved}`)

  const result = {
    schema: 'stracker.vector-map-performance-gate.v2',
    generatedAt: new Date().toISOString(),
    viewport: { width: 390, height: 844 },
    coordinateValuesRetained: false,
    hosts: [...providerHosts].sort(),
    metrics: {
      initialRouteTransferredBytes,
      ...adapterMetrics,
      activeRafFps,
      vector: {
        requests: vectorProviderRequests,
        contentLengthBytes: vectorProviderContentLengthBytes,
        bytesObserved: vectorProviderBytesObserved,
      },
      raster: {
        requests: rasterProviderRequests,
        contentLengthBytes: rasterProviderContentLengthBytes,
        adapterResourceCount: rasterAdapterMetrics.rasterResourceCount,
        adapterTransferredBytes: rasterAdapterMetrics.rasterTransferredBytes,
        bytesObserved: rasterProviderBytesObserved,
      },
    },
    budgets,
    gates: {
      INITIAL_ROUTE_TRANSFER: 'PASS',
      FIRST_MAP_VISIBLE: 'PASS',
      FIRST_MAP_INTERACTIVE: 'PASS',
      ACTIVE_RAF_FPS: 'PASS',
      LONG_TASKS: 'PASS',
      VECTOR_PROVIDER_REQUESTS: 'PASS',
      VECTOR_PROVIDER_BYTES: 'PASS',
      RASTER_PROVIDER_REQUESTS: 'PASS',
      RASTER_PROVIDER_BYTES: 'PASS',
      PERFORMANCE_BUDGETS: 'PASS',
    },
  }
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  console.log('RASTER_TRANSFER_BUDGETS=PASS')
  console.log('PERFORMANCE_BUDGETS=PASS')
  await context.close()
} finally {
  await browser.close()
}
