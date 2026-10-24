import puppeteer from 'puppeteer-core'

const executablePath = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:4173'
const viewports = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
})

try {
  for (const viewport of viewports) {
    const context = await browser.createBrowserContext()
    await context.overridePermissions(baseUrl, ['geolocation'])
    const page = await context.newPage()
    await page.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await page.setGeolocation({ latitude: -31.6, longitude: -60.7, accuracy: 12 })

    const pageErrors = []
    const relevantConsoleErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
        relevantConsoleErrors.push(message.text())
      }
    })

    await page.goto(baseUrl, { waitUntil: 'networkidle0' })
    assert(await page.$eval('body', (body) => body.scrollWidth <= window.innerWidth), `overflow selector ${viewport.width}x${viewport.height}`)
    assert((await page.$$eval('button', (buttons) => buttons.length)) === 2, 'selector must show exactly two primary choices')
    assert((await page.content()).includes('MI UBICACIÓN'), 'my location option missing')
    assert((await page.content()).includes('UBICACIÓN COMPARTIDA'), 'shared location option missing')
    assert(!(await page.content()).includes('leaflet-container'), 'map must remain locked before source selection')

    const tooSmall = await page.$$eval('button', (buttons) => buttons.filter((button) => {
      const rect = button.getBoundingClientRect()
      return rect.width < 44 || rect.height < 44
    }).length)
    assert(tooSmall === 0, `touch target below 44px at ${viewport.width}x${viewport.height}`)

    await page.$$eval('button', (buttons) => {
      const target = buttons.find((button) => button.textContent?.includes('MI UBICACIÓN'))
      if (!(target instanceof HTMLElement)) throw new Error('my location button not found')
      target.click()
    })
    await page.waitForFunction(() => document.body.textContent?.includes('PERMITIR UBICACIÓN'))
    assert(!(await page.content()).includes('maplibregl-map'), 'map must remain locked before geolocation permission action')

    await page.$$eval('button', (buttons) => {
      const target = buttons.find((button) => button.textContent?.includes('PERMITIR UBICACIÓN'))
      if (!(target instanceof HTMLElement)) throw new Error('permission button not found')
      target.click()
    })
    await page.waitForSelector('.maplibregl-map', { timeout: 20000 })
    assert((await page.content()).includes('MI UBICACIÓN'), 'active source label missing')
    assert((await page.content()).includes('ATLAS ISOMÉTRICO 2.5D'), 'default isometric 2.5D view missing')
    await page.reload({ waitUntil: 'networkidle0' })
    await page.waitForSelector('.maplibregl-map', { timeout: 20000 })
    assert(!(await page.content()).includes('PERMITIR UBICACIÓN'), 'reload must restore the last location without asking again')
    assert((await page.content()).includes('PAUSADA'), 'restored location must be clearly marked paused')
    assert(await page.$eval('body', (body) => body.scrollWidth <= window.innerWidth), `overflow map ${viewport.width}x${viewport.height}`)
    assert(pageErrors.length === 0, `pageerror at ${viewport.width}x${viewport.height}: ${pageErrors.join(' | ')}`)
    assert(relevantConsoleErrors.length === 0, `console errors at ${viewport.width}x${viewport.height}: ${relevantConsoleErrors.join(' | ')}`)
    await context.close()
  }

  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setViewport({ width: 320, height: 568, isMobile: true, hasTouch: true })
  await page.goto(baseUrl, { waitUntil: 'networkidle0' })
  await page.$$eval('button', (buttons) => {
    const target = buttons.find((button) => button.textContent?.includes('UBICACIÓN COMPARTIDA'))
    if (!(target instanceof HTMLElement)) throw new Error('shared button not found')
    target.click()
  })
  await page.waitForFunction(() => {
    const text = document.body.textContent || ''
    return text.includes('Vincular sesión de Google Maps') || text.includes('Ubicación compartida sintética')
  })
  assert(!(await page.content()).includes('maplibregl-map'), 'shared map must remain locked without validated gateway response')
  assert(await page.$eval('body', (body) => body.scrollWidth <= window.innerWidth), 'shared onboarding overflow')
  if ((await page.content()).includes('STAGING SINTÉTICO')) {
    assert((await page.content()).includes('DATOS NO REALES'), 'staging synthetic warning missing')
    assert(!(await page.content()).includes('Cookie Editor JSON'), 'staging must not offer real cookie import')
  }
  await context.close()

  const restoreContext = await browser.createBrowserContext()
  const restorePage = await restoreContext.newPage()
  await restorePage.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await restorePage.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await restorePage.evaluate(() => {
    localStorage.setItem('stracker.lastSelectedSource', 'google-shared')
    localStorage.setItem('stracker.sharedSessionLinked.v1', '1')
  })
  await restorePage.reload({ waitUntil: 'domcontentloaded' })
  await restorePage.waitForFunction(() => document.body.textContent?.includes('Recuperando sesión guardada') || document.body.textContent?.includes('Sesión guardada'), { timeout: 15000 })
  assert(!(await restorePage.content()).includes('Vincular sesión de Google Maps'), 'remembered shared session must not ask for cookies when backend is unavailable')
  assert(!(await restorePage.content()).includes('Cookie Editor JSON'), 'remembered shared session must not render the cookie importer')
  await restoreContext.close()

  console.log(`MOBILE_QA_PASS viewports=${viewports.length} pageerror=0 overflow=0 touch_targets=pass map_locking=pass`)
} finally {
  await browser.close()
}
