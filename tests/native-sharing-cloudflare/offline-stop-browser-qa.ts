// @ts-nocheck
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import puppeteer from 'puppeteer-core'
import { handleNativeSharingRequest } from '../../native-sharing-cloudflare/src/worker.js'
import { TestNativeSharingNamespace } from './test-runtime.js'

const chrome = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const expectedSha = process.env.STRACKER_EXPECTED_SHA || process.env.SOURCE_SHA || 'local-controlled-pilot'
const expectedVersionId = process.env.STRACKER_EXPECTED_VERSION_ID || 'local-controlled-pilot'
const overrideVersion = process.env.STRACKER_VERSION_OVERRIDE || ''
const output = process.env.OFFLINE_STOP_QA_OUTPUT || '/tmp/stracker-offline-stop-browser.json'
const configuredTarget = process.env.STRACKER_QA_URL || ''
const root = process.cwd()

class QaFailure extends Error {
  constructor(code) { super(code); this.code = code }
}
const ok = (value, code) => { if (!value) throw new QaFailure(code) }

function contentType(path) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' })[extname(path)] || 'application/octet-stream'
}

async function localAsset(request) {
  const url = new URL(request.url)
  if (url.pathname === '/__stracker/version.json') {
    return Response.json({ sourceSha: expectedSha, versionId: expectedVersionId }, { headers: { 'Cache-Control': 'no-store' } })
  }
  let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  if (!relative) relative = 'index.html'
  else if (relative === 'share' || relative === 'share/') relative = 'share/index.html'
  const path = join(root, 'out', normalize(relative).replace(/^\.\.(?:\/|\\|$)+/, ''))
  try {
    return new Response(await readFile(path), { status: 200, headers: { 'Content-Type': contentType(path), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } })
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

async function installFakes(page) {
  await page.evaluateOnNewDocument(() => {
    let online = true
    let watchId = 0
    const watchers = new Map()
    const point = () => ({
      coords: { latitude: 10.1234, longitude: 20.5678, accuracy: 12, altitude: null, altitudeAccuracy: null, heading: 10, speed: 1, toJSON: () => ({}) },
      timestamp: Date.now(),
      toJSON: () => ({}),
    })
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => ({ state: 'granted' }) } })
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => ({ released: false, release: async () => undefined, addEventListener: () => undefined }) } })
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) { setTimeout(() => success(point()), 0) },
        watchPosition(success) { const id = ++watchId; watchers.set(id, success); return id },
        clearWatch(id) { watchers.delete(id) },
      },
    })
    Object.defineProperty(window, '__offlineStopQA', {
      value: { setOnline(value) { online = value; window.dispatchEvent(new Event(value ? 'online' : 'offline')) } },
    })
  })
}

let server = null
let target
if (configuredTarget) {
  target = new URL(configuredTarget)
  if (target.protocol !== 'https:') throw new Error('HTTPS_TARGET_REQUIRED')
} else {
  const namespace = new TestNativeSharingNamespace()
  const env = { NATIVE_SHARING: namespace, ASSETS: { fetch: localAsset } }
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => handleNativeSharingRequest(request, env) })
  target = new URL(`http://${server.hostname}:${server.port}`)
}

let browser
const network = { blockApi: false, synthetic503Responses: 0, classified503ConsoleErrors: 0 }
const pageErrors = []
const consoleErrors = []
const result = {
  schema: 'stracker.offline-stop-browser.v1',
  sourceSha: expectedSha,
  targetUrl: target.origin + '/',
  privateDataUsed: false,
  realCoordinatesUsed: false,
  capabilityOrTokenRetained: false,
  pageErrorTotal: 0,
  relevantConsoleErrors: 0,
  gates: {},
}

try {
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await installFakes(page)
  await page.setRequestInterception(true)
  page.on('pageerror', () => pageErrors.push('PAGEERROR'))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text().replace(/https?:\/\/\S+/gi, '[URL]').slice(0, 160)
    const expectedSynthetic503 = /Failed to load resource.*503/i.test(text) && network.classified503ConsoleErrors < network.synthetic503Responses
    if (expectedSynthetic503) {
      network.classified503ConsoleErrors += 1
      return
    }
    consoleErrors.push(text)
  })
  page.on('request', (request) => {
    void (async () => {
      const url = new URL(request.url())
      const sameOrigin = url.origin === target.origin
      if (sameOrigin && network.blockApi && url.pathname.startsWith('/api/share/')) {
        network.synthetic503Responses += 1
        return request.respond({ status: 503, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify({ status: 'error', error: 'SERVICE_UNAVAILABLE' }) })
      }
      if (sameOrigin && overrideVersion) {
        return request.continue({ headers: { ...request.headers(), 'Cloudflare-Workers-Version-Overrides': `stracker="${overrideVersion}"` } })
      }
      return request.continue()
    })().catch(() => request.abort().catch(() => undefined))
  })

  await page.goto(new URL('/share', target).href, { waitUntil: 'networkidle0', timeout: 60_000 })
  await click(page, 'INICIAR TRANSMISIÓN')
  await page.waitForSelector('main[data-sharing-state="active"]', { timeout: 60_000 })

  network.blockApi = true
  await page.evaluate(() => window.__offlineStopQA.setOnline(false))
  await page.waitForSelector('main[data-network-state="offline"]', { timeout: 10_000 })
  await click(page, 'DETENER Y REVOCAR ENLACE')
  await page.waitForSelector('main[data-sharing-state="error"]', { timeout: 30_000 })
  const failedStopText = await page.evaluate(() => document.body.textContent || '')
  ok(failedStopText.includes('No se confirmó la revocación'), 'OFFLINE_STOP_ACTIONABLE')
  ok(!failedStopText.includes('REVOKED') && !failedStopText.includes('REVOCADA'), 'OFFLINE_STOP_FALSE_REVOKED')

  network.blockApi = false
  await page.evaluate(() => window.__offlineStopQA.setOnline(true))
  await click(page, 'DETENER Y REVOCAR ENLACE')
  await page.waitForSelector('main[data-sharing-state="revoked"]', { timeout: 30_000 })

  result.pageErrorTotal = pageErrors.length
  result.relevantConsoleErrors = consoleErrors.length
  ok(network.synthetic503Responses === 1, 'SYNTHETIC_FAILURE_NOT_EXACT')
  ok(result.pageErrorTotal === 0, 'PAGEERROR_TOTAL')
  ok(result.relevantConsoleErrors === 0, 'RELEVANT_CONSOLE_ERRORS')
  result.gates = {
    OFFLINE_STOP_DOES_NOT_FALSELY_REPORT_REVOKED: 'PASS',
    STOP_REVOKE_CONFIRMED: 'PASS',
    SYNTHETIC_FAILURE_CLASSIFICATION_EXACT: 'PASS',
  }
  await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
  console.log('OFFLINE_STOP_BROWSER_QA=PASS')
} catch (error) {
  if (consoleErrors.length) console.error(`SANITIZED_CONSOLE_ERRORS=${JSON.stringify(consoleErrors.slice(0, 5))}`)
  console.error(`OFFLINE_STOP_BROWSER_QA=FAIL code=${error instanceof QaFailure ? error.code : 'UNEXPECTED'}`)
  throw error
} finally {
  await browser?.close()
  server?.stop(true)
}
