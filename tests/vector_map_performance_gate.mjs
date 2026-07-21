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
    const target = buttons.find((button) => button.textContent?.toUpperCase().includes(String(expected).toUpperCase()))
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
  let providerRequests = 0
  let providerContentLengthBytes = 0
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.hostname === 'tiles.openfreemap.org') {
      providerHosts.add(url.hostname)
      providerRequests += 1
    }
  })
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.hostname !== 'tiles.openfreemap.org') return
    const length = Number(response.headers()['content-length'] || 0)
    if (Number.isFinite(length) && length > 0) providerContentLengthBytes += length
  })

  await page.goto(baseUrl, { waitUntil: 'networkidle0' })
  const initialResources = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => ({
    transferSize: entry.transferSize || 0,
    encodedBodySize: entry.encodedBodySize || 0,
  })))
  const initialRouteTransferredBytes = initialResources.reduce((sum, item) => sum + (item.transferSize || item.encodedBodySize || 0), 0)
  assert(initialRouteTransferredBytes <= budgets.initialRouteTransferredBytesMax, `initial route transfer budget exceeded: ${initialRouteTransferredBytes}`)
  assert(providerRequests === 0, 'provider requested before source selection')

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

  const metrics = await page.$eval('main[data-map-engine="maplibre"]', (node) => ({
    firstMapVisibleMs: Number(node.getAttribute('data-map-first-visible-ms')),
    firstMapInteractiveMs: Number(node.getAttribute('data-map-first-interactive-ms')),
    estimatedFps: Number(node.getAttribute('data-map-fps')),
    longTasks: Number(node.getAttribute('data-map-long-tasks')),
    longTaskDurationMs: Number(node.getAttribute('data-map-long-task-ms')),
    resourceTimingTransferredBytes: Number(node.getAttribute('data-map-transferred-bytes')),
  }))

  assert(metrics.firstMapVisibleMs > 0 && metrics.firstMapVisibleMs <= budgets.firstMapVisibleMsMax, `first map visible budget exceeded: ${metrics.firstMapVisibleMs}`)
  assert(metrics.firstMapInteractiveMs > 0 && metrics.firstMapInteractiveMs <= budgets.firstMapInteractiveMsMax, `first map interactive budget exceeded: ${metrics.firstMapInteractiveMs}`)
  assert(metrics.estimatedFps >= budgets.estimatedFpsFloor, `FPS floor missed: ${metrics.estimatedFps}`)
  assert(metrics.longTasks <= budgets.longTaskCountMax, `long task count exceeded: ${metrics.longTasks}`)
  assert(metrics.longTaskDurationMs <= budgets.longTaskDurationMsMax, `long task duration exceeded: ${metrics.longTaskDurationMs}`)
  assert(providerRequests <= budgets.mapProviderRequestsFirstViewportMax, `provider request budget exceeded: ${providerRequests}`)
  const providerBytesObserved = Math.max(providerContentLengthBytes, metrics.resourceTimingTransferredBytes)
  assert(providerBytesObserved <= budgets.mapProviderTransferredBytesFirstViewportMax, `provider byte budget exceeded: ${providerBytesObserved}`)

  const result = {
    schema: 'stracker.vector-map-performance-gate.v1',
    generatedAt: new Date().toISOString(),
    viewport: { width: 390, height: 844 },
    coordinateValuesRetained: false,
    hosts: [...providerHosts].sort(),
    metrics: {
      initialRouteTransferredBytes,
      ...metrics,
      providerRequests,
      providerContentLengthBytes,
      providerBytesObserved,
    },
    budgets,
    gates: {
      INITIAL_ROUTE_TRANSFER: 'PASS',
      FIRST_MAP_VISIBLE: 'PASS',
      FIRST_MAP_INTERACTIVE: 'PASS',
      ESTIMATED_FPS: 'PASS',
      LONG_TASKS: 'PASS',
      PROVIDER_REQUESTS: 'PASS',
      PROVIDER_BYTES: 'PASS',
      PERFORMANCE_BUDGETS: 'PASS',
    },
  }
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  console.log('PERFORMANCE_BUDGETS=PASS')
  await context.close()
} finally {
  await browser.close()
}
