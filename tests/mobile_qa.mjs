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
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
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
    assert(!(await page.content()).includes('leaflet-container'), 'map must remain locked before geolocation permission action')

    await page.$$eval('button', (buttons) => {
      const target = buttons.find((button) => button.textContent?.includes('PERMITIR UBICACIÓN'))
      if (!(target instanceof HTMLElement)) throw new Error('permission button not found')
      target.click()
    })
    await page.waitForSelector('.leaflet-container', { timeout: 15000 })
    assert((await page.content()).includes('MI UBICACIÓN'), 'active source label missing')
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
  await page.waitForFunction(() => document.body.textContent?.includes('Vincular sesión de Google Maps'))
  assert(!(await page.content()).includes('leaflet-container'), 'shared map must remain locked without validated session')
  assert(await page.$eval('body', (body) => body.scrollWidth <= window.innerWidth), 'shared onboarding overflow')
  await context.close()

  console.log(`MOBILE_QA_PASS viewports=${viewports.length} pageerror=0 overflow=0 touch_targets=pass map_locking=pass`)
} finally {
  await browser.close()
}
