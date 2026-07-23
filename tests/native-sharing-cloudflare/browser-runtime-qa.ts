import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import puppeteer from 'puppeteer-core'
import { handleNativeSharingRequest } from '../../native-sharing-cloudflare/src/worker.js'
import type { NativeSharingRuntimeBindings } from '../../native-sharing-cloudflare/src/runtime-contracts.js'
import { TestNativeSharingNamespace } from './test-runtime.js'

const executablePath = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const outputPath = process.env.QA_CLOUDFLARE_OUTPUT || '/tmp/native-sharing-cloudflare-browser.json'
const rootDirectory = process.cwd()
const viewports = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
]

interface Observation {
  method: string
  pathname: string
  queryPresent: boolean
  capabilityPresent: boolean
  authorizationPresent: boolean
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function mime(path: string): string {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.woff2': return 'font/woff2'
    default: return 'application/octet-stream'
  }
}

async function assetResponse(request: Request): Promise<Response> {
  const url = new URL(request.url)
  let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  if (!relative) relative = 'index.html'
  else if (relative === 'share' || relative === 'share/') relative = 'share/index.html'
  else if (relative === 'shared' || relative === 'shared/') relative = 'shared/index.html'
  const safe = normalize(relative).replace(/^\.\.(?:\/|\\|$)+/, '')
  const path = join(rootDirectory, 'out', safe)
  try {
    const body = await readFile(path)
    const headers = new Headers({
      'Content-Type': mime(path),
      'X-Content-Type-Options': 'nosniff',
    })
    if (url.pathname === '/shared' || url.pathname === '/shared/') {
      headers.set('Cache-Control', 'no-store, max-age=0')
      headers.set('Referrer-Policy', 'no-referrer')
      headers.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    }
    return new Response(body, { status: 200, headers })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

async function clickText(page: puppeteer.Page, text: string): Promise<void> {
  await page.$$eval('button', (buttons, expected) => {
    const target = buttons.find((button) => button.textContent?.toUpperCase().includes(String(expected).toUpperCase()))
    if (!(target instanceof HTMLElement)) throw new Error(`button not found: ${expected}`)
    target.click()
  }, text)
}

async function installSyntheticGeolocation(page: puppeteer.Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const watchers = new Map<number, PositionCallback>()
    let nextId = 1
    const position = (): GeolocationPosition => ({
      coords: {
        latitude: 10.1234,
        longitude: 20.5678,
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
        getCurrentPosition(success: PositionCallback) { setTimeout(() => success(position()), 0) },
        watchPosition(success: PositionCallback) {
          const id = nextId++
          watchers.set(id, success)
          setTimeout(() => success(position()), 0)
          return id
        },
        clearWatch(id: number) { watchers.delete(id) },
      },
    })
  })
}

async function noOverflow(page: puppeteer.Page): Promise<void> {
  assert(await page.$eval('body', (body) => body.scrollWidth <= window.innerWidth), 'horizontal overflow')
}

const namespace = new TestNativeSharingNamespace()
let currentCapability = ''
const observations: Observation[] = []
const env: NativeSharingRuntimeBindings = {
  NATIVE_SHARING: namespace,
  ASSETS: { fetch: assetResponse },
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    observations.push({
      method: request.method,
      pathname: url.pathname,
      queryPresent: Boolean(url.search),
      capabilityPresent: Boolean(currentCapability && request.url.includes(currentCapability)),
      authorizationPresent: /^Bearer [A-Za-z0-9_-]{43}$/.test(request.headers.get('Authorization') ?? ''),
    })
    return handleNativeSharingRequest(request, env)
  },
})
const baseUrl = `http://${server.hostname}:${server.port}`

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
})

const results = {
  schema: 'stracker.native-sharing-cloudflare-browser.v1',
  privateDataUsed: false,
  coordinateValuesRetained: false,
  secretValuesRetained: false,
  viewports: [] as Array<Record<string, unknown>>,
  gates: {} as Record<string, string>,
}

try {
  for (const viewport of viewports) {
    const context = await browser.createBrowserContext()
    const emitterPage = await context.newPage()
    await emitterPage.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await installSyntheticGeolocation(emitterPage)
    const errors: string[] = []
    emitterPage.on('pageerror', (error) => errors.push(error.message))

    const beforeEmitter = observations.length
    await emitterPage.goto(`${baseUrl}/share`, { waitUntil: 'networkidle0' })
    await noOverflow(emitterPage)
    assert(observations.slice(beforeEmitter).every((entry) => !entry.pathname.startsWith('/api/share/')), 'emitter used API before confirmation')
    await clickText(emitterPage, 'INICIAR TRANSMISIÓN')
    await emitterPage.waitForFunction(() => document.body.textContent?.includes('ENLACE PRIVADO'))
    currentCapability = await emitterPage.$eval('input[aria-label="Enlace privado de espectador"]', (input) => {
      const value = (input as HTMLInputElement).value
      return new URL(value).hash.replace(/^#v=/, '')
    })
    assert(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(currentCapability), 'viewer capability format invalid')

    const viewerPage = await context.newPage()
    await viewerPage.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await installSyntheticGeolocation(viewerPage)
    viewerPage.on('pageerror', (error) => errors.push(error.message))
    const beforeViewer = observations.length
    await viewerPage.goto(`${baseUrl}/shared#v=${encodeURIComponent(currentCapability)}`, { waitUntil: 'networkidle0' })
    await noOverflow(viewerPage)
    const initial = observations.slice(beforeViewer)
    const documentRequest = initial.find((entry) => entry.method === 'GET' && (entry.pathname === '/shared' || entry.pathname === '/shared/'))
    assert(documentRequest, 'shared document request missing')
    assert(documentRequest.queryPresent === false, 'query reached shared HTTP request')
    assert(documentRequest.capabilityPresent === false, 'capability reached shared HTTP request')
    assert(initial.every((entry) => !entry.pathname.startsWith('/api/share/')), 'API request before viewer confirmation')
    assert((await viewerPage.$$('main[data-map-engine]')).length === 0, 'map before viewer confirmation')

    await clickText(viewerPage, 'VER UBICACIÓN')
    await viewerPage.waitForFunction(() => window.location.pathname === '/shared' && window.location.search === '' && window.location.hash === '')
    await viewerPage.waitForSelector('main[data-map-engine="maplibre"]', { timeout: 30_000 })
    await viewerPage.waitForFunction(() => document.querySelector('main[data-freshness]') !== null)
    const afterConfirmation = observations.slice(beforeViewer)
    const exchanges = afterConfirmation.filter((entry) => entry.pathname === '/api/share/viewer/exchange')
    const polls = afterConfirmation.filter((entry) => entry.method === 'GET' && (entry.pathname.endsWith('/status') || entry.pathname.endsWith('/points')))
    assert(exchanges.length === 1, 'capability exchange count invalid')
    assert(polls.length >= 2, 'viewer polling missing')
    assert(polls.every((entry) => entry.authorizationPresent), 'polling lacked opaque bearer')
    assert(afterConfirmation.every((entry) => !entry.capabilityPresent), 'capability entered transport URL')
    assert(!viewerPage.url().includes('#') && !viewerPage.url().includes(currentCapability), 'fragment was not removed')
    assert(errors.length === 0, `pageerror: ${errors.join(' | ')}`)

    results.viewports.push({ ...viewport, pageErrors: 0, noOverflow: true, exchangeCount: 1, opaquePolling: true })
    await context.close()
    currentCapability = ''
  }

  results.gates = {
    BROWSER_QA: 'PASS',
    WORKER_SQLITE_E2E: 'PASS',
    NO_NETWORK_BEFORE_VIEWER_CONFIRMATION: 'PASS',
    CAPABILITY_FRAGMENT_ONLY: 'PASS',
    CAPABILITY_EXCHANGE_REQUIRED: 'PASS',
    OPAQUE_VIEWER_SESSION_POLLING: 'PASS',
    CAPABILITY_IN_TRANSPORT_URL: 'NO',
    VIEWPORTS_5: 'PASS',
  }
  await Bun.write(outputPath, `${JSON.stringify(results, null, 2)}\n`)
  console.log('NATIVE_SHARING_CLOUDFLARE_BROWSER_QA=PASS viewports=5')
} finally {
  await browser.close()
  server.stop(true)
  namespace.close()
}
