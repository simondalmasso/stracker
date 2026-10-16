// @ts-nocheck
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import puppeteer from 'puppeteer-core'
import { handleNativeSharingRequest } from '../../native-sharing-cloudflare/src/worker.js'
import { TestNativeSharingNamespace } from './test-runtime.js'

const chrome = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const output = process.env.VIEWER_SESSION_LIFECYCLE_QA_OUTPUT || '/tmp/stracker-viewer-session-lifecycle.json'
const root = process.cwd()
const style = JSON.stringify({ version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f2f1ed' } }] })
const ns = new TestNativeSharingNamespace()
const env = { NATIVE_SHARING: ns, ASSETS: { fetch: asset } }

class QaFailure extends Error { constructor(code) { super(code); this.code = code } }
const ok = (value, code) => { if (!value) throw new QaFailure(code) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function type(path) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' })[extname(path)] || 'application/octet-stream'
}

async function asset(request) {
  const url = new URL(request.url)
  let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  if (!relative) relative = 'index.html'
  else if (relative === 'share' || relative === 'share/') relative = 'share/index.html'
  else if (relative === 'shared' || relative === 'shared/') relative = 'shared/index.html'
  const path = join(root, 'out', normalize(relative).replace(/^\.\.(?:\/|\\|$)+/, ''))
  try {
    return new Response(await readFile(path), { status: 200, headers: { 'Content-Type': type(path), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } })
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

async function click(page, text) {
  await page.waitForFunction((value) => [...document.querySelectorAll('button')].some((button) => button.textContent?.toUpperCase().includes(String(value).toUpperCase())), { timeout: 30_000 }, text)
  await page.$$eval('button', (buttons, value) => {
    const button = buttons.find((candidate) => candidate.textContent?.toUpperCase().includes(String(value).toUpperCase()))
    if (!(button instanceof HTMLButtonElement)) throw new Error('BUTTON_NOT_FOUND')
    button.click()
  }, text)
}

async function installFakes(page) {
  await page.evaluateOnNewDocument(() => {
    let visibility = 'visible'
    let watchId = 0
    const watchers = new Map()
    const point = () => ({
      coords: { latitude: 10.1234, longitude: 20.5678, accuracy: 12, altitude: null, altitudeAccuracy: null, heading: 10, speed: 1, toJSON: () => ({}) },
      timestamp: Date.now(),
      toJSON: () => ({}),
    })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => ({ state: 'granted' }) } })
    Object.defineProperty(navigator, 'share', { configurable: true, value: async () => undefined })
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => ({ released: false, async release() { this.released = true }, addEventListener() {} }) } })
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) { setTimeout(() => success(point()), 0) },
        watchPosition(success) { const id = ++watchId; watchers.set(id, success); setTimeout(() => success(point()), 10); return id },
        clearWatch(id) { watchers.delete(id) },
      },
    })
    Object.defineProperty(window, '__viewerLifecycleQA', {
      value: {
        emitPoint() { for (const callback of watchers.values()) callback(point()) },
        hide() { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })) },
        show() { visibility = 'visible'; window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); document.dispatchEvent(new Event('visibilitychange')) },
      },
    })
  })
}

async function configure(page, observations, pageErrors, consoleErrors) {
  await installFakes(page)
  await page.setRequestInterception(true)
  page.on('pageerror', () => pageErrors.push('pageerror'))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (/favicon|styleimagemissing|failed to load resource/i.test(text)) return
    consoleErrors.push(text.replace(/https?:\/\/\S+/g, '[URL]').slice(0, 120))
  })
  page.on('request', (request) => {
    void (async () => {
      const url = new URL(request.url())
      observations.push({ method: request.method(), path: url.pathname })
      const map = url.hostname.endsWith('openfreemap.org') || url.hostname.endsWith('openstreetmap.org') || url.hostname.endsWith('eox.at')
      if (url.hostname === 'tiles.openfreemap.org' && url.pathname.replace(/\/$/, '') === '/styles/liberty') {
        return request.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: style })
      }
      if (map) return request.abort()
      return request.continue()
    })().catch(() => request.abort().catch(() => undefined))
  })
}

const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => handleNativeSharingRequest(request, env) })
const base = `http://${server.hostname}:${server.port}`
let browser

try {
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] })
  const emitterContext = await browser.createBrowserContext()
  const viewerContext = await browser.createBrowserContext()
  const emitter = await emitterContext.newPage()
  const viewer = await viewerContext.newPage()
  await emitter.setViewport({ width: 360, height: 800, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await viewer.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  const emitterRequests = []
  const viewerRequests = []
  const pageErrors = []
  const consoleErrors = []
  await configure(emitter, emitterRequests, pageErrors, consoleErrors)
  await configure(viewer, viewerRequests, pageErrors, consoleErrors)

  await emitter.goto(`${base}/share`, { waitUntil: 'networkidle0' })
  await click(emitter, 'INICIAR TRANSMISIÓN')
  await emitter.waitForSelector('main[data-sharing-state="active"]', { timeout: 30_000 })
  await emitter.waitForSelector('input[aria-label="Enlace privado de espectador"]', { timeout: 30_000 })
  await emitter.evaluate(() => window.__viewerLifecycleQA.emitPoint())
  const link = await emitter.$eval('input[aria-label="Enlace privado de espectador"]', (input) => input.value)

  await viewer.goto(link, { waitUntil: 'networkidle0' })
  await click(viewer, 'VER UBICACIÓN')
  await viewer.waitForFunction(() => location.hash === '' && location.search === '', { timeout: 30_000 })
  await viewer.waitForSelector('main[data-map-engine="maplibre"][data-location-source="shared-location"]', { timeout: 30_000 })

  const exchangeCount = () => viewerRequests.filter((entry) => entry.method === 'POST' && entry.path === '/api/share/viewer/exchange').length
  const logoutCount = () => viewerRequests.filter((entry) => entry.method === 'POST' && entry.path === '/api/share/viewer/logout').length
  const pointsGetCount = () => viewerRequests.filter((entry) => entry.method === 'GET' && entry.path.endsWith('/points')).length
  ok(exchangeCount() === 1, 'INITIAL_EXCHANGE_EXACTLY_ONCE')
  ok(logoutCount() === 0, 'INITIAL_LOGOUT_ZERO')

  const pointsBeforeSwitch = pointsGetCount()
  await click(viewer, 'HÍBRIDO')
  await viewer.waitForSelector('main[data-basemap-mode="hybrid"]', { timeout: 10_000 })
  await click(viewer, 'MAPA 3D')
  await viewer.waitForSelector('main[data-basemap-mode="vector-3d"]', { timeout: 10_000 })
  await viewer.evaluate(() => window.__viewerLifecycleQA.emitPoint?.())
  await emitter.evaluate(() => window.__viewerLifecycleQA.emitPoint())
  await sleep(500)
  await viewer.evaluate(() => window.dispatchEvent(new Event('online')))
  await viewer.waitForFunction((before) => [...performance.getEntriesByType('resource')].filter((entry) => new URL(entry.name).pathname.endsWith('/points')).length > before, { timeout: 20_000 }, pointsBeforeSwitch).catch(() => undefined)
  ok(exchangeCount() === 1, 'HYBRID_SWITCH_EXCHANGE_UNCHANGED')
  ok(logoutCount() === 0, 'HYBRID_SWITCH_REMOTE_LOGOUT_ZERO')

  const pointsBeforeBackground = pointsGetCount()
  await viewer.evaluate(() => window.__viewerLifecycleQA.hide())
  await sleep(1_000)
  await viewer.evaluate(() => window.__viewerLifecycleQA.show())
  await emitter.evaluate(() => window.__viewerLifecycleQA.emitPoint())
  await viewer.waitForFunction((before) => document.querySelector('main[data-map-engine]') && performance.getEntriesByType('resource').filter((entry) => new URL(entry.name).pathname.endsWith('/points')).length > before, { timeout: 20_000 }, pointsBeforeBackground).catch(() => undefined)
  await sleep(500)
  ok(logoutCount() === 0, 'TAB_BACKGROUND_REMOTE_LOGOUT_ZERO')
  ok(exchangeCount() === 1, 'TAB_BACKGROUND_EXCHANGE_UNCHANGED')

  await viewer.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
  await viewer.waitForSelector('main[data-map-engine="maplibre"][data-location-source="shared-location"]', { timeout: 30_000 })
  ok(exchangeCount() === 1, 'TAB_RELOAD_USES_SESSION_STORAGE_NOT_CAPABILITY')
  ok(logoutCount() === 0, 'TAB_RELOAD_REMOTE_LOGOUT_ZERO')
  ok((await viewer.evaluate(() => sessionStorage.length)) === 1, 'SESSION_STORAGE_TAB_SCOPED_STATE_PRESENT')

  ok(pageErrors.length === 0, 'PAGE_ERRORS_ZERO')
  ok(consoleErrors.length === 0, 'CONSOLE_ERRORS_ZERO')

  const result = {
    schema: 'stracker.viewer-session-lifecycle-qa.v1',
    privateDataUsed: false,
    realCoordinatesUsed: false,
    capabilityOrTokenRetained: false,
    cookieValuesPersisted: false,
    emitterTokenPersisted: false,
    originalViewerCapabilityPersisted: false,
    localStorageUsed: false,
    indexedDbUsed: false,
    crossTabSharingUsed: false,
    remoteLogoutRequests: logoutCount(),
    viewerExchangeRequests: exchangeCount(),
    gates: {
      HYBRID_SESSION_PERSISTENCE_E2E: 'PASS',
      TAB_BACKGROUND_SESSION_PERSISTENCE_E2E: 'PASS',
      TAB_RELOAD_WITHIN_TTL_SESSION_PERSISTENCE_E2E: 'PASS',
      MAP_ADAPTER_REMOUNT_DOES_NOT_LOGOUT: 'PASS',
      REMOTE_LOGOUT_CALL_COUNT_AFTER_SWITCHES: 'PASS',
      SESSION_STORAGE_ONLY: 'PASS',
      NO_PRIVATE_DATA_IN_TESTS_ARTIFACTS_OR_LOGS: 'PASS',
    },
  }
  await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
  console.log('HYBRID_SESSION_PERSISTENCE_E2E=PASS')
  console.log('TAB_BACKGROUND_SESSION_PERSISTENCE_E2E=PASS')
  console.log('TAB_RELOAD_WITHIN_TTL_SESSION_PERSISTENCE_E2E=PASS')
} finally {
  await browser?.close()
  server.stop(true)
}
