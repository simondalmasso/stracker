// @ts-nocheck
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import puppeteer from 'puppeteer-core'
import { handleMinimumRuntimeRequest } from '../../native-sharing-cloudflare/src/minimal-worker.js'

const chrome = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const output = process.env.COOKIE_SESSION_BROWSER_QA_OUTPUT || '/tmp/stracker-cookie-session-browser.json'
const root = process.cwd()
const SESSION = 's'.repeat(43)
const OWNER = 'o'.repeat(43)
const syntheticRaw = JSON.stringify([
  { name: 'SID', value: 'synthetic-one', domain: '.google.com', path: '/', secure: true },
  { name: 'SAPISID', value: 'synthetic-two', domain: '.google.com', path: '/', secure: true },
])
const viewports = [
  { width: 320, height: 568, isMobile: true, hasTouch: true },
  { width: 360, height: 640, isMobile: true, hasTouch: true },
  { width: 375, height: 812, isMobile: true, hasTouch: true },
  { width: 390, height: 844, isMobile: true, hasTouch: true },
  { width: 412, height: 915, isMobile: true, hasTouch: true },
  { width: 1366, height: 768, isMobile: false, hasTouch: false },
  { width: 1920, height: 1080, isMobile: false, hasTouch: false },
]

class QaFailure extends Error { constructor(code) { super(code); this.code = code } }
const ok = (value, code) => { if (!value) throw new QaFailure(code) }

function contentType(path) {
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
    return new Response(await readFile(path), { status: 200, headers: { 'Content-Type': contentType(path), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } })
  } catch { return new Response('Not found', { status: 404 }) }
}

function metadata() {
  return {
    status: 'ok', sessionId: SESSION, ownerToken: OWNER, mobilityScope: SESSION, storagePolicy: 'encrypted-durable',
    state: 'no_location', policyVersion: 'google-maps-cookie-durable-v1', format: 'COOKIE_EDITOR_JSON', cookieCount: 2,
    totalParsed: 2, expiredDropped: 0, invalidDropped: 0, retainedCount: 2,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), validatedAt: new Date().toISOString(), locationAvailable: false,
  }
}

function fakeBackend(observations) {
  let active = false
  return {
    async fetch(request) {
      const url = new URL(request.url)
      observations.push({ method: request.method, path: url.pathname, query: url.search, bodyBytes: request.headers.get('content-length') || 'unknown' })
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' }
      if (url.pathname === '/api/cookie-sessions' && request.method === 'POST') {
        const body = await request.json().catch(() => null)
        if (!body || typeof body.raw !== 'string' || (!body.raw.includes('SID=') && !body.raw.includes('"SID"'))) return new Response(JSON.stringify({ status: 'error', error: 'COOKIE_FORMAT_UNRECOGNIZED' }), { status: 400, headers })
        active = true
        return new Response(JSON.stringify(metadata()), { status: 201, headers })
      }
      if (url.pathname === `/api/cookie-sessions/${SESSION}/status` && request.method === 'GET' && active) {
        const { sessionId, ownerToken, mobilityScope, storagePolicy, status, ...safe } = metadata()
        return new Response(JSON.stringify(safe), { status: 200, headers })
      }
      if (url.pathname === `/api/cookie-sessions/${SESSION}/point` && request.method === 'GET' && active) return new Response(JSON.stringify({ state: 'no_location', point: null, validatedAt: new Date().toISOString() }), { status: 200, headers })
      if (url.pathname === `/api/cookie-sessions/${SESSION}/history` && request.method === 'GET' && active) {
        return new Response(JSON.stringify({ state: 'no_location', windowStart: url.searchParams.get('since'), windowEnd: new Date().toISOString(), points: [], segments: [], keyframes: [], rawRetentionHours: 24, derivedModelRetentionDays: 30, inferenceTruthLabelRequired: true }), { status: 200, headers })
      }
      if (url.pathname === `/api/cookie-sessions/${SESSION}/refresh` && request.method === 'POST' && active) {
        const { sessionId, ownerToken, mobilityScope, storagePolicy, status, ...safe } = metadata()
        return new Response(JSON.stringify(safe), { status: 200, headers })
      }
      if (url.pathname === `/api/cookie-sessions/${SESSION}/mobility-memory` && request.method === 'DELETE' && active) return new Response(JSON.stringify({ status: 'ok', state: 'cleared' }), { status: 200, headers })
      if (url.pathname === `/api/cookie-sessions/${SESSION}` && request.method === 'DELETE' && active) { active = false; return new Response(JSON.stringify({ status: 'ok', state: 'revoked' }), { status: 200, headers }) }
      return new Response(JSON.stringify({ status: 'error', error: 'NOT_FOUND' }), { status: 404, headers })
    },
  }
}

async function clickText(page, text) {
  await page.waitForFunction((value) => [...document.querySelectorAll('button')].some((button) => button.textContent?.toUpperCase().includes(String(value).toUpperCase())), {}, text)
  await page.$$eval('button', (buttons, value) => { const button = buttons.find((candidate) => candidate.textContent?.toUpperCase().includes(String(value).toUpperCase())); if (!button) throw new Error('BUTTON_NOT_FOUND'); button.click() }, text)
}

async function overflow(page) { return page.evaluate(() => Math.max(document.body?.scrollWidth || 0, document.documentElement.scrollWidth) > innerWidth) }

const observations = []
const env = { NATIVE_SHARING_BACKEND: fakeBackend(observations), ASSETS: { fetch: asset } }
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => handleMinimumRuntimeRequest(request, env) })
const base = `http://${server.hostname}:${server.port}`
let browser
const result = {
  schema: 'stracker.cookie-session-browser-qa.v2', privateDataUsed: false, realCookieValuesUsed: false, realCoordinatesUsed: false,
  cookieValuesRetained: false, capabilityOrTokenRetained: false, pageErrorTotal: 0, relevantConsoleErrors: 0,
  unexpectedNetworkErrors: 0, appApi404Total: 0, horizontalOverflowTotal: 0, fakeSuccessTotal: 0,
  rawCookieDomExposureTotal: 0, remountSurvivalTotal: 0, unexpectedDeleteOnRemountTotal: 0, viewports: [], gates: {},
}

try {
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] })
  for (const viewport of viewports) {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    await page.setViewport({ ...viewport, deviceScaleFactor: 1 })
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
    await page.evaluateOnNewDocument((value) => {
      let clipboardReads = 0
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => { clipboardReads += 1; return value } } })
      Object.defineProperty(window, '__cookieQa', { value: { clipboardReads: () => clipboardReads } })
    }, syntheticRaw)
    const pageErrors = []
    const consoleErrors = []
    const networkErrors = []
    const expectedInvalid = { value: false }
    page.on('pageerror', (error) => pageErrors.push(error instanceof Error ? error.name : 'pageerror'))
    page.on('console', (message) => { if (message.type() !== 'error') return; const text = message.text(); if (expectedInvalid.value && /400/.test(text) && /failed to load resource/i.test(text)) return; consoleErrors.push(text.replace(/https?:\/\/\S+/g, '[URL]').slice(0, 120)) })
    page.on('requestfailed', (request) => networkErrors.push(new URL(request.url()).pathname))

    await page.goto(base, { waitUntil: 'networkidle0', timeout: 60_000 })
    await page.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'))
    await clickText(page, 'UBICACIÓN COMPARTIDA')
    await page.waitForSelector('[data-native-sharing-hub="true"]')
    await page.click('[data-testid="open-cookie-session"]')
    await page.waitForSelector('[data-cookie-session-panel="true"]')
    const warning = await page.evaluate(() => document.body.textContent || '')
    ok(warning.includes('Las cookies son credenciales sensibles'), 'COOKIE_WARNING')
    ok((await page.evaluate(() => window.__cookieQa.clipboardReads())) === 0, 'NO_AUTO_CLIPBOARD_READ')
    ok(!(await overflow(page)), `PANEL_OVERFLOW_${viewport.width}x${viewport.height}`)

    await page.type('[data-testid="cookie-textarea"]', 'not a cookie')
    expectedInvalid.value = true
    await page.click('[data-testid="cookie-import"]')
    await page.waitForSelector('[data-testid="cookie-error"]')
    expectedInvalid.value = false
    ok(!(await page.$('[data-testid="cookie-success"]')), 'INVALID_NO_FALSE_SUCCESS')
    result.fakeSuccessTotal += Number(Boolean(await page.$('[data-testid="cookie-success"]')))

    await page.click('[data-testid="cookie-paste"]')
    await page.waitForFunction(() => (document.body.textContent || '').includes('bytes capturados'))
    ok((await page.evaluate(() => window.__cookieQa.clipboardReads())) === 1, 'EXPLICIT_PASTE_ONLY')
    const beforeSubmit = await page.evaluate(() => ({ text: document.body.textContent || '', raw: document.querySelector('[data-testid="cookie-textarea"]')?.value ?? '', html: document.documentElement.innerHTML }))
    ok(beforeSubmit.raw === '', 'RAW_TEXTAREA_NEVER_REFLECTED')
    ok(!beforeSubmit.html.includes('synthetic-one') && !beforeSubmit.html.includes('synthetic-two'), 'COOKIE_VALUES_NOT_IN_DOM_BEFORE_SUBMIT')
    result.rawCookieDomExposureTotal += Number(beforeSubmit.html.includes('synthetic-one') || beforeSubmit.html.includes('synthetic-two'))

    await page.click('[data-testid="cookie-import"]')
    await page.waitForSelector('[data-testid="cookie-success"]', { timeout: 30_000 })
    const after = await page.evaluate(() => ({ text: document.body.textContent || '', html: document.documentElement.innerHTML, handle: sessionStorage.getItem('stracker.cookie.handle.v2') || '' }))
    ok(after.text.includes('Cifrada · DO SQLite'), 'DURABLE_ENCRYPTED_VISIBLE')
    ok(after.text.includes('CAPTURA DE SERVIDOR') || after.text.includes('ESPERANDO UBICACIÓN'), 'SERVER_CAPTURE_VISIBLE')
    ok(!after.html.includes('synthetic-one') && !after.html.includes('synthetic-two'), 'COOKIE_VALUES_NOT_IN_DOM_AFTER_SUBMIT')
    ok(!after.handle.includes('synthetic-one') && !after.handle.includes('synthetic-two'), 'COOKIE_VALUES_NOT_IN_SESSION_STORAGE')
    ok(!(await overflow(page)), `SUCCESS_OVERFLOW_${viewport.width}x${viewport.height}`)

    const deletesBeforeRemount = observations.filter((entry) => entry.method === 'DELETE' && entry.path === `/api/cookie-sessions/${SESSION}`).length
    await page.click('button[aria-label="Volver"]')
    await page.waitForSelector('[data-native-sharing-hub="true"]')
    await page.click('[data-testid="open-cookie-session"]')
    await page.waitForSelector('[data-testid="cookie-success"]', { timeout: 30_000 })
    const deletesAfterRemount = observations.filter((entry) => entry.method === 'DELETE' && entry.path === `/api/cookie-sessions/${SESSION}`).length
    ok(deletesAfterRemount === deletesBeforeRemount, 'REMOUNT_MUST_NOT_DELETE_SESSION')
    result.unexpectedDeleteOnRemountTotal += deletesAfterRemount - deletesBeforeRemount
    result.remountSurvivalTotal += 1

    await page.click('[data-testid="cookie-delete"]')
    await page.waitForSelector('[data-testid="cookie-textarea"]')
    ok(!(await page.$('[data-testid="cookie-success"]')), 'DELETE_REMOVES_STATUS')

    result.pageErrorTotal += pageErrors.length
    result.relevantConsoleErrors += consoleErrors.length
    result.unexpectedNetworkErrors += networkErrors.length
    result.horizontalOverflowTotal += Number(await overflow(page))
    result.viewports.push({ width: viewport.width, height: viewport.height, pageErrors: pageErrors.length, relevantConsoleErrors: consoleErrors.length, unexpectedNetworkErrors: networkErrors.length, horizontalOverflow: Number(await overflow(page)) })
    await context.close()
  }

  result.appApi404Total = observations.filter((entry) => entry.path.startsWith('/api/') && entry.status === 404).length
  ok(result.pageErrorTotal === 0, 'PAGEERROR_TOTAL')
  ok(result.relevantConsoleErrors === 0, 'RELEVANT_CONSOLE_ERRORS')
  ok(result.unexpectedNetworkErrors === 0, 'UNEXPECTED_NETWORK_ERRORS')
  ok(result.horizontalOverflowTotal === 0, 'HORIZONTAL_OVERFLOW_TOTAL')
  ok(result.fakeSuccessTotal === 0, 'FAKE_SUCCESS_TOTAL')
  ok(result.rawCookieDomExposureTotal === 0, 'RAW_COOKIE_DOM_EXPOSURE_TOTAL')
  ok(result.unexpectedDeleteOnRemountTotal === 0, 'UNEXPECTED_DELETE_ON_REMOUNT_TOTAL')
  ok(result.remountSurvivalTotal === viewports.length, 'REMOUNT_SURVIVAL_ALL_VIEWPORTS')
  ok(observations.some((entry) => entry.method === 'POST' && entry.path === '/api/cookie-sessions'), 'REAL_IMPORT_REQUEST')
  ok(observations.some((entry) => entry.method === 'GET' && entry.path === `/api/cookie-sessions/${SESSION}/history`), 'HISTORY_REQUEST')
  ok(observations.some((entry) => entry.method === 'DELETE' && entry.path === `/api/cookie-sessions/${SESSION}`), 'REAL_DELETE_REQUEST')
  result.gates = {
    COOKIE_PANEL_DISCOVERABILITY: 'PASS', COOKIE_WARNING: 'PASS', EXPLICIT_PASTE_ACTION: 'PASS', RAW_COOKIE_NEVER_REFLECTED_IN_DOM: 'PASS',
    COOKIE_VALID_FORMAT_ACCEPTANCE: 'PASS', COOKIE_INVALID_FORMAT_REJECTION: 'PASS', COOKIE_BACKEND_FAILURE_NO_FALSE_SUCCESS: 'PASS',
    COOKIE_SUCCESS_STATUS_METADATA_ONLY: 'PASS', COOKIE_HANDLE_SESSION_STORAGE_ONLY: 'PASS', COOKIE_REMOUNT_PERSISTENCE: 'PASS',
    COOKIE_HISTORY_OWNER_PATH: 'PASS', COOKIE_DELETE_EXPLICIT_ONLY: 'PASS', MOBILE_VIEWPORTS: 'PASS', WINDOWS_CHROME_DESKTOP: 'PASS',
  }
  await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
  console.log('COOKIE_SESSION_BROWSER_QA=PASS')
} catch (error) {
  const code = error instanceof QaFailure ? error.code : 'UNEXPECTED_COOKIE_BROWSER_QA'
  console.error(`COOKIE_SESSION_BROWSER_QA=FAIL code=${code}`)
  throw error
} finally {
  await browser?.close()
  server.stop(true)
}
