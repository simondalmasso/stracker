import puppeteer from 'puppeteer-core'

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_BIN,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
})
const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:4173'
const errors = []
try {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(baseUrl, { waitUntil: 'networkidle0' })
  await page.evaluate(() => {
    const now = new Date().toISOString()
    localStorage.setItem('stracker.lastSelectedSource', 'my-device')
    localStorage.setItem('stracker.lastMyLocation.v1', JSON.stringify({
      source: 'my-device',
      lat: -31.6,
      lng: -60.7,
      accuracyM: 12,
      capturedAt: now,
      receivedAt: now,
      freshness: 'fresh',
    }))
  })
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForSelector('.maplibregl-map .maplibregl-canvas', { timeout: 20000 })
  const canvasHeight = await page.$eval('.maplibregl-canvas', (canvas) => canvas.height)
  if (canvasHeight < 900 * 0.8) throw new Error(`map canvas height ${canvasHeight}px is too small for 900px desktop viewport`)
  const initialText = await page.evaluate(() => document.body.innerText)
  if (!initialText.includes('ATLAS ISOMÉTRICO 2.5D')) throw new Error('3D atlas is not the default desktop view')
  if (await page.$eval('body', (body) => body.scrollWidth > window.innerWidth)) throw new Error('desktop horizontal overflow')
  await page.click('button[aria-label="Activar vista satélite"]')
  await page.waitForFunction(() => document.body.textContent?.includes('SATÉLITE'), { timeout: 5000 })
  await page.click('button[aria-label="Volver al atlas 3D"]')
  await page.waitForFunction(() => document.body.textContent?.includes('ATLAS ISOMÉTRICO 2.5D'), { timeout: 5000 })
  if (errors.length) throw new Error('desktop page errors: ' + errors.join(' | '))
  console.log('DESKTOP_ATLAS_QA_PASS viewport=1440x900 default=3d satellite_toggle=pass overflow=0 pageerror=0')
  await context.close()
} finally {
  await browser.close()
}
