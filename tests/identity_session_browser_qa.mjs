import puppeteer from 'puppeteer-core'

const executablePath = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:4173'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function clickText(page, text) {
  await page.$$eval('button', (buttons, expected) => {
    const target = buttons.find((button) => button.textContent?.toUpperCase().includes(String(expected).toUpperCase()))
    if (!(target instanceof HTMLElement)) throw new Error(`button not found: ${expected}`)
    target.click()
  }, text)
}

async function noOverflow(page, label) {
  assert(await page.$eval('body', (body) => body.scrollWidth <= window.innerWidth), `horizontal overflow: ${label}`)
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
})

try {
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
    const context = await browser.createBrowserContext()
    const page = await context.newPage()
    await page.setViewport({ ...viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.setRequestInterception(true)
    page.on('request', async (request) => {
      const url = new URL(request.url())
      if (url.origin === new URL(baseUrl).origin && url.pathname === '/api/session/status') {
        await request.respond({
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Stracker-Gateway': 'private-poc-v1', 'Cache-Control': 'no-store' },
          body: JSON.stringify({
            appAuthenticated: true,
            state: 'SHARED_UNCONFIGURED',
            health: 'UNCONFIGURED',
            configured: false,
            formatDetected: null,
            count: 0,
            criticalPresent: [],
            criticalMissing: [],
            message: 'No hay una sesión vinculada.',
          }),
        })
        return
      }
      await request.continue()
    })

    await page.goto(baseUrl, { waitUntil: 'networkidle0' })
    assert(!(await page.content()).includes('CONTINUAR CON GOOGLE'), 'React duplicated the Access login action')
    await clickText(page, 'UBICACIÓN COMPARTIDA')
    await page.waitForFunction(() => document.body.textContent?.includes('VINCULAR GOOGLE MAPS'))
    const text = await page.$eval('body', (body) => body.textContent || '')
    assert(text.includes('Importar una sesión autorizada'), 'authorized-session copy missing')
    assert(text.includes('NO VINCULADA'), 'unlinked state missing')
    assert(!text.includes('AUTORIZAR CON GOOGLE'), 'false OAuth claim shown')
    assert(!text.includes('CONECTAR MEDIANTE OAUTH'), 'false OAuth claim shown')
    assert(!text.includes('API OFICIAL DE LOCATION SHARING'), 'false API claim shown')
    await noOverflow(page, `${viewport.width}x${viewport.height}`)
    assert(pageErrors.length === 0, `pageerror: ${pageErrors.join(' | ')}`)
    await context.close()
  }
  console.log('IDENTITY_SESSION_BROWSER_QA=PASS pageerror=0 overflow=0')
} finally {
  await browser.close()
}
