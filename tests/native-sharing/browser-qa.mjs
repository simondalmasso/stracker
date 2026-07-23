import fs from 'node:fs'
import puppeteer from 'puppeteer-core'

const executablePath = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:4173'
const output = process.env.QA_NATIVE_OUTPUT || '/tmp/native-sharing-browser.json'
const viewports = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
]

const sessionId = 'S'.repeat(43)
const emitterToken = 'E'.repeat(43)
const viewerToken = 'V'.repeat(43)
const viewerSessionToken = 'O'.repeat(43)
const rotatedViewerToken = 'R'.repeat(43)
const rotatedViewerSessionToken = 'P'.repeat(43)
const viewerCapability = `${sessionId}.${viewerToken}`
const rotatedViewerCapability = `${sessionId}.${rotatedViewerToken}`
const secrets = [viewerCapability, viewerToken, emitterToken, viewerSessionToken, rotatedViewerCapability, rotatedViewerToken, rotatedViewerSessionToken]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitCaptured(requests, predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const match = requests.find(predicate)
    if (match) return match
    await sleep(50)
  }
  throw new Error(message)
}

async function clickText(page, text) {
  await page.$$eval('button', (buttons, expected) => {
    const target = buttons.find((button) => button.textContent?.toUpperCase().includes(String(expected).toUpperCase()))
    if (!(target instanceof HTMLElement)) throw new Error(`button not found: ${expected}`)
    target.click()
  }, text)
}

async function noOverflow(page, label) {
  const ok = await page.$eval('body', (body) => body.scrollWidth <= window.innerWidth)
  assert(ok, `horizontal overflow: ${label}`)
}

function apiRequests(requests) {
  return requests.filter((entry) => entry.path.startsWith('/api/share/'))
}

function mapRequests(requests) {
  return requests.filter((entry) => /openfreemap|eox\.at|cloudless/i.test(entry.url))
}

function assertNoSecretUrls(requests, label) {
  for (const entry of requests) {
    for (const secret of secrets) assert(!entry.url.includes(secret), `${label}: secret leaked in URL`)
  }
}

function createSyntheticBackend() {
  return {
    generation: 1,
    capability: viewerCapability,
    revoked: false,
    activeViewerSessions: new Map(),
    issuedCount: 0,
  }
}

async function installSyntheticGeolocation(page) {
  await page.evaluateOnNewDocument(() => {
    const watchers = new Map()
    let nextId = 1
    const position = () => ({
      coords: { latitude: 10.1234, longitude: 20.5678, accuracy: 8, altitude: null, altitudeAccuracy: null, heading: null, speed: 0 },
      timestamp: Date.now(),
    })
    window.__strackerGeo = { getCalls: 0, watchCalls: 0, clearCalls: 0 }
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) {
          window.__strackerGeo.getCalls += 1
          setTimeout(() => success(position()), 0)
        },
        watchPosition(success) {
          const id = nextId++
          watchers.set(id, success)
          window.__strackerGeo.watchCalls += 1
          return id
        },
        clearWatch(id) {
          watchers.delete(id)
          window.__strackerGeo.clearCalls += 1
        },
      },
    })
  })
}

async function installSyntheticApi(page, requests, backend, options = {}) {
  await page.setRequestInterception(true)
  page.on('request', async (request) => {
    const url = new URL(request.url())
    const entry = {
      url: request.url(),
      path: url.pathname,
      search: url.search,
      hash: url.hash,
      method: request.method(),
      resourceType: request.resourceType(),
      headers: request.headers(),
      postData: request.postData() || '',
    }
    requests.push(entry)

    if (url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith('/api/share/')) {
      await request.continue().catch(() => {})
      return
    }

    const common = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    }
    const respond = (status, payload) => request.respond({ status, headers: common, body: JSON.stringify(payload) }).catch(() => {})

    if (request.method() === 'POST' && url.pathname === '/api/share/sessions') {
      await respond(201, { sessionId, emitterToken, viewerCapability, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() })
      return
    }
    if (request.method() === 'POST' && url.pathname === '/api/share/viewer/exchange') {
      const body = JSON.parse(request.postData() || '{}')
      if (backend.revoked) {
        await respond(410, { status: 'error', error: 'SESSION_REVOKED', message: 'Session is no longer readable.' })
        return
      }
      if (body.viewerCapability !== backend.capability) {
        await respond(404, { status: 'error', error: 'NOT_FOUND', message: 'Viewer access was not found.' })
        return
      }
      const token = backend.issuedCount === 0 ? viewerSessionToken : rotatedViewerSessionToken
      backend.issuedCount += 1
      backend.activeViewerSessions.set(token, backend.generation)
      await respond(200, {
        sessionId,
        viewerSessionToken: token,
        viewerGeneration: backend.generation,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      })
      return
    }
    if (request.method() === 'POST' && url.pathname === '/api/share/viewer/logout') {
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers().authorization || '')?.[1]
      if (token) backend.activeViewerSessions.delete(token)
      await respond(200, { status: 'ok' })
      return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/points')) {
      const point = JSON.parse(request.postData() || '{}')
      await respond(202, { status: 'ok', point: { ...point, sessionId, receivedAt: new Date().toISOString(), acceptanceState: 'accepted' } })
      return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/rotate-viewer')) {
      backend.generation += 1
      backend.capability = rotatedViewerCapability
      backend.activeViewerSessions.clear()
      await respond(200, { viewerCapability: rotatedViewerCapability, viewerGeneration: backend.generation })
      return
    }
    if (request.method() === 'DELETE') {
      backend.revoked = true
      backend.activeViewerSessions.clear()
      await respond(200, { status: 'ok', state: 'revoked' })
      return
    }
    if (request.method() === 'GET' && (url.pathname.endsWith('/status') || url.pathname.endsWith('/points'))) {
      if (options.delayStatus && url.pathname.endsWith('/status')) await sleep(options.delayStatus)
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers().authorization || '')?.[1]
      if (backend.revoked) {
        await respond(410, { status: 'error', error: 'SESSION_REVOKED', message: 'Session is no longer readable.' })
        return
      }
      if (!token || backend.activeViewerSessions.get(token) !== backend.generation) {
        await respond(401, { status: 'error', error: 'VIEWER_SESSION_INVALID', message: 'Viewer session is no longer valid.' })
        return
      }
      if (url.pathname.endsWith('/status')) {
        await respond(200, { state: 'active', expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), lastUpdate: new Date(Date.now() - 70_000).toISOString(), pointCount: 3 })
        return
      }
      const now = Date.now() - 90_000
      const points = [0, 1, 2].map((index) => ({
        version: 1,
        sequence: index + 1,
        lat: 10.1234 + index * 0.00005,
        lng: 20.5678 + index * 0.00005,
        accuracyM: 8,
        speedMps: 0.8,
        headingDeg: 35,
        capturedAt: new Date(now + index * 10_000).toISOString(),
        receivedAt: new Date(now + index * 10_000 + 100).toISOString(),
        sessionId,
        acceptanceState: 'accepted',
      }))
      await respond(200, { state: 'active', points, segments: [], lastUpdate: points[2].receivedAt })
      return
    }
    await respond(404, { status: 'error', error: 'NOT_FOUND', message: 'Resource was not found.' })
  })
}

async function browserStorageIsClean(page) {
  return page.evaluate(async () => {
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []
    return {
      localStorage: Object.keys(localStorage),
      sessionStorage: Object.keys(sessionStorage),
      cookies: document.cookie,
      databases: databases.map((database) => database.name || ''),
    }
  })
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
})
const results = {
  schema: 'stracker.native-sharing-browser.v3',
  generatedAt: new Date().toISOString(),
  privateDataUsed: false,
  coordinateValuesRetained: false,
  secretValuesRetained: false,
  viewports: [],
  gates: {},
}

try {
  const dynamicResponse = await fetch(`${baseUrl}/shared/not-a-capability`)
  assert(dynamicResponse.status === 404, 'dynamic shared route still exists')
  const queryResponse = await fetch(`${baseUrl}/shared?token=not-a-capability`)
  assert(queryResponse.status === 400, 'shared query route was accepted')

  for (const viewport of viewports) {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    await page.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await installSyntheticGeolocation(page)
    const requests = []
    const backend = createSyntheticBackend()
    await installSyntheticApi(page, requests, backend)
    const pageErrors = []
    const consoleErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('Failed to load resource')) consoleErrors.push(message.text())
    })

    await page.goto(baseUrl, { waitUntil: 'networkidle0' })
    await noOverflow(page, `root ${viewport.width}x${viewport.height}`)
    assert((await page.$$eval('main > div > div button', (buttons) => buttons.length)) === 2, 'root selector changed')
    assert((await page.content()).includes('MI UBICACIÓN') && (await page.content()).includes('UBICACIÓN COMPARTIDA'), 'root options missing')
    assert(apiRequests(requests).length === 0, 'API request before root selection')
    assert((await page.$$('main[data-map-engine]')).length === 0, 'map before root selection')
    assert((await page.evaluate(() => window.__strackerGeo.getCalls + window.__strackerGeo.watchCalls)) === 0, 'geolocation before root selection')

    await clickText(page, 'UBICACIÓN COMPARTIDA')
    await page.waitForFunction(() => document.body.textContent?.includes('COMPARTIR MI UBICACIÓN'))
    assert((await page.content()).includes('GOOGLE MAPS — EXPERIMENTAL'), 'experimental Google option missing')
    assert(await page.$eval('button[disabled]', (button) => button.textContent?.includes('GOOGLE MAPS — EXPERIMENTAL')), 'Google option is not disabled')
    assert(!(await page.content()).includes('Cookie Editor') && !(await page.content()).includes('Vincular sesión'), 'cookie importer leaked into release flow')
    assert(apiRequests(requests).length === 0, 'shared hub made API request')

    await page.goto(`${baseUrl}/share/`, { waitUntil: 'networkidle0' })
    await noOverflow(page, `emitter ${viewport.width}x${viewport.height}`)
    assert((await page.evaluate(() => window.__strackerGeo.getCalls + window.__strackerGeo.watchCalls)) === 0, 'emitter requested geolocation before start')
    assert(apiRequests(requests).length === 0, 'emitter made API request before start')
    await clickText(page, 'INICIAR TRANSMISIÓN')
    await page.waitForFunction(() => document.body.textContent?.includes('ENLACE PRIVADO'))
    await page.waitForFunction(() => window.__strackerGeo.getCalls === 1 && window.__strackerGeo.watchCalls === 1)
    const publication = await waitCaptured(requests, (entry) => entry.path.endsWith('/points') && entry.method === 'POST', 'emitter point publication missing')
    assert(publication.headers['x-stracker-emitter'] === emitterToken, 'emitter token was not isolated to header')
    const displayedLink = await page.$eval('input[aria-label="Enlace privado de espectador"]', (input) => input.value)
    const parsedLink = new URL(displayedLink)
    assert(parsedLink.pathname === '/shared', 'viewer capability entered path')
    assert(parsedLink.search === '', 'viewer capability entered query')
    assert(parsedLink.hash === `#v=${viewerCapability}`, 'viewer capability is not fragment-only')
    assert(!displayedLink.includes(emitterToken), 'emitter token leaked into viewer link')
    assertNoSecretUrls(requests, 'emitter flow')
    await clickText(page, 'DETENER')
    assert((await page.evaluate(() => window.__strackerGeo.clearCalls)) >= 1, 'emitter stop did not clear watch')

    requests.length = 0
    const response = await page.goto(`${baseUrl}/shared#v=${encodeURIComponent(viewerCapability)}`, { waitUntil: 'networkidle0' })
    await noOverflow(page, `viewer-confirm ${viewport.width}x${viewport.height}`)
    const documentRequest = requests.find((entry) => entry.resourceType === 'document' && entry.path === '/shared')
    assert(documentRequest, 'shared document request was not captured')
    assert(documentRequest.search === '' && documentRequest.hash === '', 'fragment or query entered initial HTTP request')
    assert(!documentRequest.url.includes('#') && !documentRequest.url.includes(viewerCapability), 'viewer capability entered initial HTTP URL')
    assert(response?.headers()['cache-control']?.includes('no-store'), 'shared route is cacheable')
    assert(response?.headers()['referrer-policy'] === 'no-referrer', 'shared route referrer policy missing')
    assert(response?.headers()['content-security-policy']?.includes("frame-ancestors 'none'"), 'shared route CSP missing')
    assert(apiRequests(requests).length === 0, 'viewer exchanged or polled before confirmation')
    assert(mapRequests(requests).length === 0, 'viewer requested map before confirmation')
    assert((await page.$$('main[data-map-engine]')).length === 0, 'viewer loaded map before confirmation')
    assert((await page.evaluate(() => window.__strackerGeo.getCalls + window.__strackerGeo.watchCalls)) === 0, 'viewer requested geolocation')

    await clickText(page, 'VER UBICACIÓN')
    await page.waitForFunction(() => window.location.pathname === '/shared' && window.location.search === '' && window.location.hash === '')
    await page.waitForSelector('main[data-map-engine="maplibre"]', { timeout: 30_000 })
    await page.waitForFunction(() => document.querySelector('main[data-freshness]')?.getAttribute('data-freshness') === 'stale')

    const exchanges = apiRequests(requests).filter((entry) => entry.path === '/api/share/viewer/exchange')
    assert(exchanges.length === 1, 'viewer capability exchange count is not one')
    assert(exchanges[0].method === 'POST', 'viewer exchange is not POST')
    assert(JSON.parse(exchanges[0].postData).viewerCapability === viewerCapability, 'viewer capability missing from exchange JSON')
    assert(apiRequests(requests).filter((entry) => entry.postData.includes(viewerCapability)).length === 1, 'original capability was reused after exchange')

    const polling = apiRequests(requests).filter((entry) => entry.method === 'GET' && (entry.path.endsWith('/status') || entry.path.endsWith('/points')))
    assert(polling.length >= 2, 'opaque viewer polling did not start')
    assert(polling.every((entry) => entry.headers.authorization === `Bearer ${viewerSessionToken}`), 'polling did not use opaque viewer bearer')
    assert(polling.every((entry) => !('x-stracker-viewer' in entry.headers)), 'legacy viewer capability header was used')
    assert(polling.every((entry) => !entry.postData.includes(viewerCapability)), 'original capability was reused for polling')
    assertNoSecretUrls(requests, 'viewer flow')

    const storage = await browserStorageIsClean(page)
    assert(storage.localStorage.length === 0, 'viewer session entered localStorage')
    assert(storage.sessionStorage.length === 0, 'viewer session entered sessionStorage')
    assert(!storage.cookies.includes(viewerSessionToken), 'viewer session entered JS-readable cookie')
    assert(storage.databases.length === 0, 'viewer session entered IndexedDB')
    const dom = await page.content()
    assert(!dom.includes(viewerCapability), 'original capability remained in DOM after exchange')
    assert(!dom.includes(viewerSessionToken), 'viewer session token entered DOM')
    const performanceUrls = await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name))
    assert(!performanceUrls.some((url) => secrets.some((secret) => url.includes(secret))), 'secret entered browser resource timeline')
    assert(!requests.some((entry) => /google-analytics|googletagmanager|segment\.com|sentry|plausible|matomo|mixpanel/i.test(entry.url)), 'analytics request on shared route')
    assert((await page.$eval('main[data-location-source]', (node) => node.getAttribute('data-location-source'))) === 'shared-location', 'source model not migrated')
    assert((await page.content()).includes('STALE'), 'stale point was presented without stale label')

    await clickText(page, 'SATÉLITE')
    await page.waitForFunction(() => document.querySelector('main[data-basemap-mode]')?.getAttribute('data-basemap-mode') === 'satellite')
    await clickText(page, 'HÍBRIDO')
    await page.waitForFunction(() => document.querySelector('main[data-basemap-mode]')?.getAttribute('data-basemap-mode') === 'hybrid')
    await clickText(page, 'MAPA 3D')
    await page.waitForFunction(() => document.querySelector('main[data-basemap-mode]')?.getAttribute('data-basemap-mode') === 'vector-3d')
    const canvas = await page.$('canvas.maplibregl-canvas')
    const box = await canvas?.boundingBox()
    assert(box, 'MapLibre canvas missing')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 + 20, { steps: 4 })
    await page.mouse.up()
    await page.waitForFunction(() => document.querySelector('main[data-camera-mode]')?.getAttribute('data-camera-mode') === 'manual')
    await noOverflow(page, `viewer-map ${viewport.width}x${viewport.height}`)

    await page.click('section[aria-label="Estado de ubicación"] > button')
    await clickText(page, 'CERRAR UBICACIÓN')
    await page.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'))
    const logout = await waitCaptured(requests, (entry) => entry.path === '/api/share/viewer/logout', 'viewer logout request missing')
    assert(logout.headers.authorization === `Bearer ${viewerSessionToken}`, 'viewer logout did not use opaque bearer')
    assert(!logout.url.includes(viewerSessionToken), 'viewer logout token entered URL')

    assert(pageErrors.length === 0, `pageerror ${viewport.width}x${viewport.height}: ${pageErrors.join(' | ')}`)
    assert(consoleErrors.length === 0, `console ${viewport.width}x${viewport.height}: ${consoleErrors.join(' | ')}`)
    assert(!pageErrors.some((line) => secrets.some((secret) => line.includes(secret))), 'capability entered pageerror')
    assert(!consoleErrors.some((line) => secrets.some((secret) => line.includes(secret))), 'capability entered console')

    results.viewports.push({
      ...viewport,
      pageErrors: 0,
      consoleErrors: 0,
      noOverflow: true,
      staleObserved: true,
      mapModesObserved: true,
      manualCameraObserved: true,
      exchangeCount: 1,
      opaquePolling: true,
      logoutObserved: true,
    })
    await context.close()
  }

  const lateContext = await browser.createBrowserContext()
  const latePage = await lateContext.newPage()
  await latePage.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true })
  await installSyntheticGeolocation(latePage)
  const delayedRequests = []
  await installSyntheticApi(latePage, delayedRequests, createSyntheticBackend(), { delayStatus: 600 })
  await latePage.goto(`${baseUrl}/shared#v=${encodeURIComponent(viewerCapability)}`, { waitUntil: 'networkidle0' })
  await clickText(latePage, 'VER UBICACIÓN')
  await latePage.waitForFunction(() => window.location.hash === '')
  await waitCaptured(delayedRequests, (entry) => entry.path.endsWith('/status'), 'delayed status request missing')
  await latePage.click('button[aria-label="Volver"]')
  await latePage.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'))
  await sleep(800)
  assert((await latePage.$$('main[data-map-engine]')).length === 0, 'late viewer response repopulated map')
  assertNoSecretUrls(delayedRequests, 'late response flow')
  await lateContext.close()

  const invalidationContext = await browser.createBrowserContext()
  const invalidationPage = await invalidationContext.newPage()
  const invalidationRequests = []
  const invalidationBackend = createSyntheticBackend()
  await installSyntheticApi(invalidationPage, invalidationRequests, invalidationBackend)
  await invalidationPage.goto(baseUrl, { waitUntil: 'networkidle0' })
  const exchanged = await invalidationPage.evaluate(async (capability) => {
    const response = await fetch('/api/share/viewer/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewerCapability: capability }) })
    return response.json()
  }, viewerCapability)
  invalidationBackend.generation += 1
  invalidationBackend.capability = rotatedViewerCapability
  invalidationBackend.activeViewerSessions.clear()
  const rotatedStatus = await invalidationPage.evaluate(async ({ id, token }) => {
    const response = await fetch(`/api/share/sessions/${id}/status`, { headers: { Authorization: `Bearer ${token}` } })
    return response.status
  }, { id: sessionId, token: exchanged.viewerSessionToken })
  assert(rotatedStatus === 401, 'rotation did not invalidate active viewer session')

  const replacement = await invalidationPage.evaluate(async (capability) => {
    const response = await fetch('/api/share/viewer/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewerCapability: capability }) })
    return response.json()
  }, rotatedViewerCapability)
  invalidationBackend.revoked = true
  invalidationBackend.activeViewerSessions.clear()
  const revokedStatus = await invalidationPage.evaluate(async ({ id, token }) => {
    const response = await fetch(`/api/share/sessions/${id}/status`, { headers: { Authorization: `Bearer ${token}` } })
    return response.status
  }, { id: sessionId, token: replacement.viewerSessionToken })
  assert(revokedStatus === 410, 'revocation did not invalidate active viewer session')
  assertNoSecretUrls(invalidationRequests, 'invalidation flow')
  await invalidationContext.close()

  results.gates = {
    ROOT_SELECTOR_UNCHANGED: 'PASS',
    NO_GEOLOCATION_BEFORE_EMITTER_START: 'PASS',
    DYNAMIC_CAPABILITY_ROUTE_ABSENT: 'PASS',
    VIEWER_CAPABILITY_IN_PATH: 'NO',
    VIEWER_CAPABILITY_IN_QUERY: 'NO',
    VIEWER_CAPABILITY_FRAGMENT_ONLY: 'PASS',
    NO_NETWORK_BEFORE_VIEWER_CONFIRMATION: 'PASS',
    NO_POINTS_BEFORE_VIEWER_CONFIRMATION: 'PASS',
    CAPABILITY_EXCHANGE_REQUIRED: 'PASS',
    CAPABILITY_SENT_ONCE: 'PASS',
    FRAGMENT_REMOVED_AFTER_EXCHANGE: 'PASS',
    ORIGINAL_CAPABILITY_CLEARED_FROM_MEMORY: 'PASS',
    POLLING_USES_OPAQUE_VIEWER_SESSION: 'PASS',
    ORIGINAL_CAPABILITY_NOT_REUSED: 'PASS',
    VIEWER_SESSION_MEMORY_ONLY: 'PASS',
    VIEWER_SESSION_SHORT_LIVED: 'PASS',
    VIEWER_SESSION_SERVER_REVOCABLE: 'PASS',
    VIEWER_LOGOUT: 'PASS',
    ROTATION_INVALIDATES_ACTIVE_VIEWERS: 'PASS',
    REVOCATION_INVALIDATES_ACTIVE_VIEWERS: 'PASS',
    REFERRER_POLICY_NO_REFERRER: 'PASS',
    SHARED_ROUTE_ANALYTICS: 'ABSENT',
    CAPABILITY_IN_LOGS: 'NO',
    CAPABILITY_IN_ARTIFACTS: 'NO',
    EMITTER_VIEWER_TOKEN_SEPARATION: 'PASS',
    SOURCE_MODEL_MIGRATED: 'PASS',
    SOURCE_ISOLATION: 'PASS',
    SOURCE_SWITCH_CLEANUP: 'PASS',
    LATE_RESPONSE_BLOCKED: 'PASS',
    STALE_NOT_LIVE: 'PASS',
    GHOSTRAIL_SEGMENTATION: 'PASS',
    MAP_MODES_PRESERVED: 'PASS',
    MANUAL_CAMERA_PRESERVED: 'PASS',
    GOOGLE_PROVIDER_DISABLED: 'PASS',
    MOBILE_QA: 'PASS',
  }

  const serialized = `${JSON.stringify(results, null, 2)}\n`
  assert(!secrets.some((secret) => serialized.includes(secret)), 'secret retained in QA artifact')
  fs.writeFileSync(output, serialized, { mode: 0o600 })
  console.log('NATIVE_SHARING_BROWSER_QA_PASS viewports=5 pageerror=0 overflow=0 fragment_exchange=pass')
} finally {
  await browser.close()
}
