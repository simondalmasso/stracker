// @ts-nocheck
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import puppeteer from 'puppeteer-core'
import { handleNativeSharingRequest } from '../../native-sharing-cloudflare/src/worker.js'
import { TestNativeSharingNamespace } from './test-runtime.js'

const chrome = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const output = process.env.PILOT_BROWSER_QA_OUTPUT || '/tmp/stracker-controlled-pilot-browser.json'
const root = process.cwd()
const style = JSON.stringify({ version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#050505' } }] })
const ns = new TestNativeSharingNamespace()
const env = { NATIVE_SHARING: ns, ASSETS: { fetch: asset } }
const expectedDiagnosticKeys = [
  'BUILD_SHA', 'VERSION_ID', 'BROWSER_AND_OS_CLASS', 'PAGE_VISIBILITY_STATE',
  'GEOLOCATION_PERMISSION_STATE', 'NETWORK_ONLINE_STATE', 'WAKE_LOCK_SUPPORTED_AND_HELD',
  'LAST_HTTP_STATUS_CATEGORY', 'POINT_ATTEMPT_COUNT', 'POINT_SUCCESS_COUNT', 'LAST_SUCCESS_AGE_BUCKET',
].sort()

class QaFailure extends Error { constructor(code) { super(code); this.code = code } }
const ok = (value, code) => { if (!value) throw new QaFailure(code) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function type(path) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' })[extname(path)] || 'application/octet-stream'
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
  await page.waitForFunction((value) => [...document.querySelectorAll('button')].some((button) => button.textContent?.toUpperCase().includes(String(value).toUpperCase())), {}, text)
  await page.$$eval('button', (buttons, value) => {
    const button = buttons.find((candidate) => candidate.textContent?.toUpperCase().includes(String(value).toUpperCase()))
    if (!button) throw new Error('BUTTON_NOT_FOUND')
    button.click()
  }, text)
}

async function installPilotFakes(page) {
  await page.evaluateOnNewDocument(() => {
    let online = true
    let visibility = 'visible'
    let clockOffset = 0
    let clipboard = ''
    let watchId = 0
    let wakeRequests = 0
    let wakeReleases = 0
    let wakeHeld = false
    const watchers = new Map()
    const realNow = Date.now.bind(Date)
    Date.now = () => realNow() + clockOffset
    const point = () => ({
      coords: { latitude: 10.1234, longitude: 20.5678, accuracy: 12, altitude: null, altitudeAccuracy: null, heading: 10, speed: 1, toJSON: () => ({}) },
      timestamp: realNow(),
      toJSON: () => ({}),
    })
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => ({ state: 'granted' }) } })
    Object.defineProperty(navigator, 'share', { configurable: true, value: async () => undefined })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { clipboard = String(value) } } })
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async () => {
          wakeRequests += 1
          wakeHeld = true
          const listeners = []
          const sentinel = {
            released: false,
            async release() {
              if (sentinel.released) return
              sentinel.released = true
              wakeHeld = false
              wakeReleases += 1
              for (const listener of listeners) listener()
            },
            addEventListener(type, listener) { if (type === 'release') listeners.push(listener) },
          }
          return sentinel
        },
      },
    })
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) { setTimeout(() => success(point()), 0) },
        watchPosition(success) { const id = ++watchId; watchers.set(id, success); return id },
        clearWatch(id) { watchers.delete(id) },
      },
    })
    Object.defineProperty(window, '__pilotQA', {
      value: {
        setOnline(value) { online = value; window.dispatchEvent(new Event(value ? 'online' : 'offline')) },
        setVisibility(value) { visibility = value; document.dispatchEvent(new Event('visibilitychange')) },
        setClockOffset(value) { clockOffset = value },
        emitPoint() { for (const callback of watchers.values()) callback(point()) },
        wake() { return { requests: wakeRequests, releases: wakeReleases, held: wakeHeld } },
        clipboard() { return clipboard },
      },
    })
  })
}

async function configure(page, viewport, observations, errors, consoleErrors, revocation) {
  await page.setViewport(viewport)
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await installPilotFakes(page)
  await page.setRequestInterception(true)
  page.on('pageerror', () => errors.push('pageerror'))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text()
    if (revocation.value && /410/.test(text) && /failed to load resource/i.test(text)) return
    const location = message.location()
    let source = 'document'
    try { source = new URL(location.url).pathname.split('/').filter(Boolean).pop() || 'document' } catch {}
    const category =
      /net::ERR_(ABORTED|FAILED|CONNECTION|NAME_NOT_RESOLVED|CERT_AUTHORITY_INVALID)/i.test(text) ? 'NETWORK_RESOURCE_FAILURE' :
      /failed to load resource/i.test(text) ? 'RESOURCE_LOAD_FAILURE' :
      /webgl|context lost/i.test(text) ? 'WEBGL_FAILURE' :
      /cors|cross-origin/i.test(text) ? 'CORS_FAILURE' :
      /favicon/i.test(text) ? 'FAVICON_FAILURE' : 'OTHER_CONSOLE_ERROR'
    const signature = text
      .replace(/https?:\/\/\S+/gi, '[URL]')
      .replace(/\b(?:Bearer|token|capability|secret|authorization)\s*[:=]?\s*\S+/gi, '$1 [REDACTED]')
      .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[HEX]')
      .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[OPAQUE]')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 140)
    consoleErrors.push({ category, source: source.slice(0, 80), line: Number.isInteger(location.lineNumber) ? location.lineNumber : null, signature })
  })
  page.on('request', (request) => {
    void (async () => {
      const url = new URL(request.url())
      const map = url.hostname.endsWith('openfreemap.org') || url.hostname.endsWith('openstreetmap.org') || url.hostname.endsWith('eox.at')
      let sequence = null
      if (request.method() === 'POST' && url.pathname.endsWith('/points')) {
        try { sequence = JSON.parse(request.postData() || '{}').sequence ?? null } catch { sequence = null }
      }
      observations.push({ method: request.method(), path: url.pathname, api: url.pathname.startsWith('/api/share/'), map, sequence })
      if (url.hostname === 'tiles.openfreemap.org' && url.pathname.replace(/\/$/, '') === '/styles/liberty') return request.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: style })
      if (map) return request.abort()
      return request.continue()
    })().catch(() => request.abort().catch(() => undefined))
  })
}

async function overflow(page) {
  return page.evaluate(() => Math.max(document.body?.scrollWidth || 0, document.documentElement.scrollWidth) > innerWidth)
}

async function setOnline(page, value) { await page.evaluate((next) => window.__pilotQA.setOnline(next), value) }
async function setVisibility(page, value) { await page.evaluate((next) => window.__pilotQA.setVisibility(next), value) }
async function setClockOffset(page, value) { await page.evaluate((next) => window.__pilotQA.setClockOffset(next), value) }
async function emitPoint(page) { await page.evaluate(() => window.__pilotQA.emitPoint()) }
async function wakeStats(page) { return page.evaluate(() => window.__pilotQA.wake()) }

const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => handleNativeSharingRequest(request, env) })
const base = `http://${server.hostname}:${server.port}`
let browser
const result = {
  schema: 'stracker.controlled-physical-pilot-browser.v1',
  privateDataUsed: false,
  realCoordinatesUsed: false,
  syntheticCoordinateValuesRetained: false,
  capabilityOrTokenRetained: false,
  pageErrorTotal: 0,
  relevantConsoleErrors: 0,
  horizontalOverflowTotal: 0,
  offlineDurationSeconds: 30,
  gates: {},
}

try {
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--disable-dev-shm-usage'] })
  const emitterContext = await browser.createBrowserContext()
  const tclContext = await browser.createBrowserContext()
  const windowsContext = await browser.createBrowserContext()
  const emitter = await emitterContext.newPage()
  const tcl = await tclContext.newPage()
  const windows = await windowsContext.newPage()
  const emitterRequests = [], tclRequests = [], windowsRequests = []
  const errors = [], consoleErrors = []
  const revocation = { value: false }
  await configure(emitter, { width: 360, height: 800, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, emitterRequests, errors, consoleErrors, revocation)
  await configure(tcl, { width: 360, height: 800, deviceScaleFactor: 1, isMobile: true, hasTouch: true }, tclRequests, errors, consoleErrors, revocation)
  await configure(windows, { width: 1366, height: 768, deviceScaleFactor: 1, isMobile: false, hasTouch: false }, windowsRequests, errors, consoleErrors, revocation)

  await emitter.goto(`${base}/share`, { waitUntil: 'networkidle0' })
  ok((await emitter.evaluate(() => document.body.textContent || '')).includes('SÓLO EN PRIMER PLANO'), 'FOREGROUND_NOTICE')
  ok(!emitterRequests.some((entry) => entry.api), 'SESSION_BEFORE_START')
  await click(emitter, 'INICIAR TRANSMISIÓN')
  await emitter.waitForSelector('main[data-sharing-state="active"]', { timeout: 30_000 })
  await emitter.waitForSelector('input[aria-label="Enlace privado de espectador"]', { timeout: 30_000 })
  await emitPoint(emitter)
  await emitter.waitForFunction(() => document.body.textContent?.includes('AHORA'), { timeout: 30_000 })
  ok((await wakeStats(emitter)).held === true, 'WAKE_LOCK_HELD')
  ok((await emitter.evaluate(() => document.body.textContent || '')).includes('COMPARTIR'), 'WEB_SHARE_FEATURE_DETECTED')
  ok((await emitter.evaluate(() => document.body.textContent || '')).includes('BUENA'), 'ACCURACY_CATEGORY_VISIBLE')
  const link = await emitter.$eval('input[aria-label="Enlace privado de espectador"]', (input) => input.value)

  for (const viewer of [tcl, windows]) {
    await viewer.goto(link, { waitUntil: 'networkidle0' })
    ok(!viewer.url().includes('#v=') || (await viewer.evaluate(() => document.body.textContent || '')).includes('VER UBICACIÓN'), 'CAPABILITY_PRECONFIRM_ONLY')
    await click(viewer, 'VER UBICACIÓN')
    await viewer.waitForFunction(() => location.hash === '' && location.search === '', { timeout: 30_000 })
    await viewer.waitForSelector('[data-pilot-freshness="fresh"]', { timeout: 30_000 })
    ok(!(await overflow(viewer)), 'VIEWER_OVERFLOW')
  }

  await setClockOffset(tcl, 20_000)
  await setClockOffset(windows, 20_000)
  await tcl.waitForSelector('[data-pilot-freshness="delayed"]', { timeout: 10_000 })
  await windows.waitForSelector('[data-pilot-freshness="delayed"]', { timeout: 10_000 })
  await setClockOffset(tcl, 50_000)
  await setClockOffset(windows, 50_000)
  await tcl.waitForSelector('[data-pilot-freshness="stale"]', { timeout: 10_000 })
  await windows.waitForSelector('[data-pilot-freshness="stale"]', { timeout: 10_000 })
  await setClockOffset(tcl, 0)
  await setClockOffset(windows, 0)

  const beforeOffline = emitterRequests.filter((entry) => entry.path.endsWith('/points')).length
  await setOnline(emitter, false)
  await emitter.waitForSelector('main[data-network-state="offline"]')
  for (let index = 0; index < 6; index += 1) { await sleep(5_000); await emitPoint(emitter) }
  const duringOffline = emitterRequests.filter((entry) => entry.path.endsWith('/points')).length
  ok(duringOffline === beforeOffline, 'NO_OFFLINE_PUBLICATION')
  await click(emitter, 'COPIAR DIAGNÓSTICO')
  const diagnosticText = await emitter.evaluate(() => window.__pilotQA.clipboard())
  const diagnostic = JSON.parse(diagnosticText)
  ok(JSON.stringify(Object.keys(diagnostic).sort()) === JSON.stringify(expectedDiagnosticKeys), 'DIAGNOSTIC_KEYS')
  for (const forbidden of ['lat', 'lng', 'accuracyM', 'capability', 'viewerSession', 'sessionId', 'Authorization', '#v=']) ok(!diagnosticText.includes(forbidden), `DIAGNOSTIC_FORBIDDEN_${forbidden}`)

  await setOnline(emitter, true)
  await emitter.waitForFunction(() => document.querySelector('main')?.dataset.networkState === 'online', { timeout: 30_000 })
  await sleep(3_000)
  const afterRecovery = emitterRequests.filter((entry) => entry.path.endsWith('/points'))
  ok(afterRecovery.length === beforeOffline + 1, 'LATEST_POINT_ONLY_RECOVERY')
  const sequences = afterRecovery.map((entry) => entry.sequence).filter(Number.isSafeInteger)
  ok(new Set(sequences).size === sequences.length, 'NO_DUPLICATE_SEQUENCE')
  ok(sequences.every((value, index) => index === 0 || value > sequences[index - 1]), 'NO_OUT_OF_ORDER_SEQUENCE')

  await setVisibility(emitter, 'hidden')
  await emitter.waitForSelector('main[data-sharing-state="paused"]')
  ok((await wakeStats(emitter)).held === false, 'WAKE_LOCK_RELEASE_ON_HIDDEN')
  const beforeHiddenEmit = emitterRequests.filter((entry) => entry.path.endsWith('/points')).length
  await emitPoint(emitter)
  await sleep(1_000)
  ok(emitterRequests.filter((entry) => entry.path.endsWith('/points')).length === beforeHiddenEmit, 'NO_BACKGROUND_PUBLICATION')
  await setVisibility(emitter, 'visible')
  await emitter.waitForFunction(() => document.querySelector('main')?.dataset.wakeLockHeld === 'true', { timeout: 10_000 })
  ok((await wakeStats(emitter)).requests >= 2, 'WAKE_LOCK_REACQUIRE')

  revocation.value = true
  await click(emitter, 'DETENER Y REVOCAR ENLACE')
  await emitter.waitForSelector('main[data-sharing-state="revoked"]', { timeout: 30_000 })
  for (const viewer of [tcl, windows]) {
    await viewer.waitForSelector('main[data-viewer-state="revoked"]', { timeout: 30_000 })
    ok((await viewer.$$('main[data-map-engine]')).length === 0, 'REVOCATION_REMOVES_MAP')
  }
  ok((await wakeStats(emitter)).held === false, 'WAKE_LOCK_RELEASE_ON_STOP')

  result.pageErrorTotal = errors.length
  result.relevantConsoleErrors = consoleErrors.length
  result.horizontalOverflowTotal = Number(await overflow(emitter)) + Number(await overflow(tcl)) + Number(await overflow(windows))
  if (consoleErrors.length > 0) {
    const counts = new Map()
    for (const error of consoleErrors) {
      const key = `${error.category}:${error.source}:${error.line ?? 'na'}`
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    console.log('CONTROLLED_PILOT_CONSOLE_DIAGNOSTICS=' + JSON.stringify(
      [...counts.entries()].slice(0, 20).map(([key, count]) => ({ key, count })),
    ))
  }
  ok(result.pageErrorTotal === 0, 'PAGEERROR_TOTAL')
  ok(result.relevantConsoleErrors === 0, 'RELEVANT_CONSOLE_ERRORS')
  ok(result.horizontalOverflowTotal === 0, 'HORIZONTAL_OVERFLOW_TOTAL')
  result.gates = {
    VISIBILITY_FOREGROUND_CONTRACT_TESTS: 'PASS',
    NO_BACKGROUND_RELIABILITY_CLAIM_TEST: 'PASS',
    WAKE_LOCK_FEATURE_DETECTION_TESTS: 'PASS',
    WAKE_LOCK_RELEASE_TESTS: 'PASS',
    LATEST_POINT_ONLY_RETRY_TESTS: 'PASS',
    OFFLINE_30_SECOND_RECOVERY_TEST: 'PASS',
    NO_DUPLICATE_OR_OUT_OF_ORDER_TEST: 'PASS',
    FRESH_DELAYED_STALE_UI_TESTS: 'PASS',
    REVOCATION_REMOVES_MAP_TEST: 'PASS',
    SANITIZED_DIAGNOSTIC_SCAN: 'PASS',
    A22_VIEWPORT_BROWSER_E2E: 'PASS',
    TCL408_VIEWPORT_BROWSER_E2E: 'PASS',
    WINDOWS_CHROME_VIEWPORT_E2E: 'PASS',
  }
  await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
  console.log('CONTROLLED_PHYSICAL_PILOT_BROWSER_QA=PASS')
} catch (error) {
  console.error(`CONTROLLED_PHYSICAL_PILOT_BROWSER_QA=FAIL code=${error instanceof QaFailure ? error.code : 'UNEXPECTED'}`)
  throw error
} finally {
  await browser?.close()
  server.stop(true)
}
