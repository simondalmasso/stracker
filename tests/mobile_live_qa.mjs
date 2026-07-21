import assert from 'node:assert/strict'
import puppeteer from 'puppeteer-core'

const executablePath = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const baseUrl = process.env.QA_BASE_URL
const accessCookie = process.env.CLOUDFLARE_ACCESS_AUTH_COOKIE
if (!baseUrl || !accessCookie) throw new Error('QA_BASE_URL and CLOUDFLARE_ACCESS_AUTH_COOKIE are required')

const origin = new URL(baseUrl).origin
const viewports = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
]

async function authenticatedPage(browser, viewport) {
  const context = await browser.createBrowserContext()
  await context.overridePermissions(origin, ['geolocation'])
  const page = await context.newPage()
  await page.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await page.setGeolocation({ latitude: 0, longitude: 0, accuracy: 500000 })
  await page.setCookie({
    name: 'CF_Authorization',
    value: accessCookie.replace(/^CF_Authorization=/, ''),
    url: origin,
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
  })
  await page.evaluateOnNewDocument(() => {
    window.__strackerClearWatchCalls = 0
    const original = navigator.geolocation.clearWatch.bind(navigator.geolocation)
    navigator.geolocation.clearWatch = (id) => {
      window.__strackerClearWatchCalls += 1
      return original(id)
    }
  })
  return { context, page }
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
})

try {
  for (const viewport of viewports) {
    const { context, page } = await authenticatedPage(browser, viewport)
    const pageErrors = []
    const relevantConsoleErrors = []
    const sharedRequests = []
    const staticFailures = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('Failed to load resource')) relevantConsoleErrors.push(message.text())
    })
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname === '/points' || pathname.startsWith('/api/session/')) sharedRequests.push(pathname)
    })
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.startsWith('/_next/') && response.status() !== 200) staticFailures.push(`${response.status()} ${response.url()}`)
    })

    const root = await page.goto(baseUrl, { waitUntil: 'networkidle0' })
    assert.equal(root?.status(), 200, 'authenticated root must return 200')
    assert.equal(new URL(page.url()).origin, origin, 'Access authenticated navigation must remain on staging origin')
    const content = await page.content()
    assert.match(content, /STAGING SINTÉTICO · DATOS NO REALES/)
    assert.match(content, /MI UBICACIÓN/)
    assert.match(content, /UBICACIÓN COMPARTIDA/)
    assert(!content.includes('onrender.com') && !content.includes('strackerglm'), 'Render origin must be absent')
    assert(await page.$eval('body', (body) => body.scrollWidth <= window.innerWidth), `overflow selector ${viewport.width}x${viewport.height}`)
    const tooSmall = await page.$$eval('button', (buttons) => buttons.filter((button) => {
      const rect = button.getBoundingClientRect()
      return rect.width < 44 || rect.height < 44
    }).length)
    assert.equal(tooSmall, 0, `touch target below 44px at ${viewport.width}x${viewport.height}`)

    await page.$$eval('button', (buttons) => {
      const target = buttons.find((button) => button.textContent?.includes('MI UBICACIÓN'))
      if (!(target instanceof HTMLElement)) throw new Error('my location button not found')
      target.click()
    })
    await page.waitForFunction(() => document.body.textContent?.includes('PERMITIR UBICACIÓN'))
    await page.$$eval('button', (buttons) => {
      const target = buttons.find((button) => button.textContent?.includes('PERMITIR UBICACIÓN'))
      if (!(target instanceof HTMLElement)) throw new Error('permission button not found')
      target.click()
    })
    await page.waitForSelector('.leaflet-container', { timeout: 15000 })
    assert.equal(sharedRequests.length, 0, 'my-location mode must not call shared backend')
    const storage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))
    assert.deepEqual(Object.keys(storage).sort(), ['stracker.lastSelectedSource'])
    assert(!JSON.stringify(storage).includes('latitude') && !JSON.stringify(storage).includes('longitude'), 'coordinates must not be persisted')

    await page.$eval('section[aria-label="Estado de ubicación"] > button', (button) => button.click())
    await page.waitForFunction(() => document.body.textContent?.includes('Cambiar ubicación'))
    await page.$$eval('button', (buttons) => {
      const target = buttons.find((button) => button.textContent?.includes('Cambiar ubicación'))
      if (!(target instanceof HTMLElement)) throw new Error('change source button not found')
      target.click()
    })
    await page.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'))
    assert((await page.evaluate(() => window.__strackerClearWatchCalls)) > 0, 'changing source must clear geolocation watcher')
    assert.equal(pageErrors.length, 0, `pageerror ${viewport.width}x${viewport.height}: ${pageErrors.join(' | ')}`)
    assert.equal(relevantConsoleErrors.length, 0, `console errors ${viewport.width}x${viewport.height}: ${relevantConsoleErrors.join(' | ')}`)
    assert.equal(staticFailures.length, 0, `static asset failures: ${staticFailures.join(' | ')}`)
    await context.close()
  }

  const { context, page } = await authenticatedPage(browser, { width: 390, height: 844 })
  const gatewayResponses = []
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (path === '/points' || path.startsWith('/api/session/')) {
      gatewayResponses.push({ path, status: response.status(), marker: response.headers()['x-stracker-gateway'] })
    }
  })
  await page.goto(baseUrl, { waitUntil: 'networkidle0' })
  await page.$$eval('button', (buttons) => {
    const target = buttons.find((button) => button.textContent?.includes('UBICACIÓN COMPARTIDA'))
    if (!(target instanceof HTMLElement)) throw new Error('shared button not found')
    target.click()
  })
  await page.waitForFunction(() => document.body.textContent?.includes('ACTIVAR DATOS SINTÉTICOS'))
  assert.match(await page.content(), /no acepta cookies|No pegues cookies/i)
  await page.$$eval('button', (buttons) => {
    const target = buttons.find((button) => button.textContent?.includes('ACTIVAR DATOS SINTÉTICOS'))
    if (!(target instanceof HTMLElement)) throw new Error('synthetic activation button not found')
    target.click()
  })
  await page.waitForSelector('.leaflet-container', { timeout: 15000 })
  await page.$eval('section[aria-label="Estado de ubicación"] > button', (button) => button.click())
  await page.waitForFunction(() => document.body.textContent?.includes('SINTÉTICO'))
  const finalContent = await page.content()
  assert(!finalContent.includes('X-Stracker-Service-Token'), 'service token header name must not appear in rendered page')
  assert(!finalContent.includes('onrender.com') && !finalContent.includes('strackerglm'), 'Render origin must remain absent')
  assert(gatewayResponses.some((entry) => entry.path === '/api/session/import' && entry.status === 200 && entry.marker === 'private-poc-v1'))
  assert(gatewayResponses.some((entry) => entry.path === '/points' && entry.status === 200 && entry.marker === 'private-poc-v1'))
  await context.close()

  console.log('ACCESS_LOGIN_FLOW=PASS')
  console.log('STATIC_ASSETS=PASS')
  console.log('MY_LOCATION=PASS')
  console.log('SHARED_MOCK_LOCATION=PASS')
  console.log('SOURCE_ISOLATION=PASS')
  console.log('GATEWAY_ATTESTATION=PASS')
  console.log(`MOBILE_LIVE_QA_PASS viewports=${viewports.length} pageerror=0 overflow=0 touch_targets=pass`)
} finally {
  await browser.close()
}
