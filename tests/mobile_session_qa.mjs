import fs from 'node:fs'
import puppeteer from 'puppeteer-core'

const baseUrl = process.env.STRACKER_QA_URL || 'http://127.0.0.1:3000'
const viewports = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
]

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) throw new Error('Chromium executable not found')
  return found
}

const syntheticState = {
  meta: { timestamp: new Date().toISOString(), device_id: 'synthetic', version: 'qa' },
  location: { lat: 1.2345, lng: 2.3456, label_primary: 'Ubicación de prueba', since_sec: 0, distance_to_home_m: null },
  movement: { speed_kmh: 0, mode: 'STATIC', confidence: 1 },
  activity: { score: 0, level: 'LOW', screen_state: 'OFF' },
  network: { type: 'UNKNOWN', signal_quality: 'UNKNOWN' },
  device: { battery: 50, charging: false },
  spoof: { risk: 0, label: 'OK' },
  proximity: { arrival: 'NONE', mode: 'NONE', distance_m: null },
  ghostrail: { enabled: true, points_24h: [], last_zones: [], timeline_active: true },
  events: [],
}

function sessionPayload(state) {
  return {
    state,
    map_unlocked: ['READY', 'STALE', 'NO_LOCATION'].includes(state),
    configured: state !== 'UNCONFIGURED',
    format: state === 'UNCONFIGURED' ? null : 'COOKIE_HEADER_STRING',
    cookie_count: state === 'UNCONFIGURED' ? 0 : 6,
    critical_present: state === 'UNCONFIGURED' ? [] : ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID'],
    critical_missing: [],
    validation_code: state === 'NO_LOCATION' ? 'GOOGLE_NO_LOCATION' : 'SESSION_VALID',
    message: state === 'NO_LOCATION' ? 'Google no devuelve una ubicación compartida activa.' : 'Sesión validada.',
    action: state === 'NO_LOCATION' ? 'Confirmá que la ubicación compartida esté habilitada.' : 'El mapa ya puede usar la ubicación autorizada.',
  }
}

async function jsonResponse(request, status, payload) {
  await request.respond({
    status,
    contentType: 'application/json; charset=utf-8',
    headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' },
    body: JSON.stringify(payload),
  })
}

async function assertNoHorizontalOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    html: document.documentElement.scrollWidth,
    body: document.body?.scrollWidth || 0,
  }))
  if (metrics.html > metrics.viewport || metrics.body > metrics.viewport) {
    throw new Error(`${label}: horizontal overflow ${JSON.stringify(metrics)}`)
  }
}

async function runViewport(browser, viewport) {
  const page = await browser.newPage()
  const pageErrors = []
  const consoleErrors = []
  let state = 'UNCONFIGURED'
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('favicon')) consoleErrors.push(message.text())
  })
  await page.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/124 Safari/537.36')
  await page.setRequestInterception(true)
  page.on('request', async (request) => {
    const url = new URL(request.url())
    try {
      if (url.pathname === '/api/app/session') return await jsonResponse(request, 200, { status: 'ok', authenticated: true })
      if (url.pathname === '/api/session/status') return await jsonResponse(request, 200, sessionPayload(state))
      if (url.pathname === '/api/session/import') {
        const body = request.postData() || ''
        if (body.includes('INVALID')) {
          return await jsonResponse(request, 400, { status: 'error', code: 'FORMAT_NOT_RECOGNIZED', message: 'Formato no reconocido', action: 'Usá un formato compatible.' })
        }
        state = 'READY'
        return await jsonResponse(request, 200, { status: 'ok', ...sessionPayload(state) })
      }
      if (url.pathname === '/api/session/clear') {
        state = 'UNCONFIGURED'
        return await jsonResponse(request, 200, { status: 'ok', ...sessionPayload(state) })
      }
      if (url.pathname === '/points') {
        return await jsonResponse(request, 200, {
          points: [{ timestamp: new Date().toISOString(), lat: 1.2345, lng: 2.3456, speed_kmh: 0, heading: 0, address: 'Ubicación de prueba', accuracy: 10 }],
          stats: { current_speed_kmh: 0, current_heading: 0, current_heading_name: 'N', current_state: 'detenido' },
          state: syntheticState,
          ghostrail_pts: [],
          last_update: new Date().toISOString(),
          device_label: 'synthetic',
        })
      }
      if (/tile|openstreetmap|unpkg|googleapis|gstatic/.test(url.hostname)) return await request.abort()
      return await request.continue()
    } catch (error) {
      try { await request.abort() } catch {}
      console.error(error)
    }
  })

  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60_000 })
  await page.waitForSelector('[data-testid="session-welcome"]', { timeout: 20_000 })
  await assertNoHorizontalOverflow(page, `${viewport.width}x${viewport.height} welcome`)
  const mapBefore = await page.$('[data-testid="session-map"]')
  if (mapBefore) throw new Error('Map unlocked before validated session')

  await page.click('[data-testid="open-session-import"]')
  await page.waitForSelector('[data-testid="session-import"]')
  await page.focus('[data-testid="session-textarea"]')
  await assertNoHorizontalOverflow(page, `${viewport.width}x${viewport.height} keyboard-focus`)
  const header = 'SID=fake; HSID=fake; SSID=fake; APISID=fake; SAPISID=fake; __Secure-1PSID=fake'
  await page.type('[data-testid="session-textarea"]', header)
  await page.click('[data-testid="submit-session"]')
  await page.waitForSelector('[data-testid="session-map"]', { timeout: 25_000 })
  await assertNoHorizontalOverflow(page, `${viewport.width}x${viewport.height} map`)

  await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 })
  await page.waitForSelector('[data-testid="session-map"]', { timeout: 25_000 })
  await page.click('[data-testid="session-menu"]')
  await page.waitForSelector('[data-testid="session-sheet"]')
  await assertNoHorizontalOverflow(page, `${viewport.width}x${viewport.height} session-sheet`)
  await page.click('[data-testid="close-session-sheet"]')

  state = 'STALE'
  await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 })
  await page.waitForSelector('[data-testid="session-map-warning"]')
  state = 'NO_LOCATION'
  await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 })
  await page.waitForSelector('[data-testid="session-map-warning"]')

  await page.setViewport({ width: viewport.height, height: viewport.width, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await assertNoHorizontalOverflow(page, `${viewport.width}x${viewport.height} rotated`)
  await page.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true })

  await page.click('[data-testid="session-menu"]')
  await page.click('[data-testid="logout-session"]')
  await page.waitForSelector('[data-testid="session-welcome"]')

  if (pageErrors.length) throw new Error(`${viewport.width}x${viewport.height} pageerror: ${pageErrors.join(' | ')}`)
  if (consoleErrors.length) throw new Error(`${viewport.width}x${viewport.height} console errors: ${consoleErrors.join(' | ')}`)
  await page.close()
  return { viewport: `${viewport.width}x${viewport.height}`, pageerror: 0, overflow: 0, consoleErrors: 0 }
}

async function runErrorCases(browser) {
  const page = await browser.newPage()
  let statusCalls = 0
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true })
  await page.setRequestInterception(true)
  page.on('request', async (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/api/app/session') return jsonResponse(request, 200, { status: 'ok', authenticated: true })
    if (url.pathname === '/api/session/status') {
      statusCalls += 1
      return jsonResponse(request, 200, sessionPayload(statusCalls > 1 ? 'EXPIRED' : 'UNCONFIGURED'))
    }
    if (url.pathname === '/api/session/import') return jsonResponse(request, 401, { status: 'error', code: 'SESSION_EXPIRED', message: 'Sesión vencida', action: 'Reemplazá la sesión.' })
    return request.continue()
  })
  await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 60_000 })
  await page.click('[data-testid="open-session-import"]')
  await page.type('[data-testid="session-textarea"]', 'SID=fake; HSID=fake; SSID=fake; APISID=fake; SAPISID=fake; __Secure-1PSID=fake')
  await page.click('[data-testid="submit-session"]')
  await page.waitForSelector('[data-testid="session-error"]')
  const map = await page.$('[data-testid="session-map"]')
  if (map) throw new Error('Expired session unlocked map')
  if (pageErrors.length) throw new Error(`error-case pageerror: ${pageErrors.join(' | ')}`)
  await page.close()
}

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
})
try {
  const results = []
  for (const viewport of viewports) results.push(await runViewport(browser, viewport))
  await runErrorCases(browser)
  console.log(JSON.stringify({ status: 'PASS', results, errorCases: 'PASS' }))
} finally {
  await browser.close()
}
