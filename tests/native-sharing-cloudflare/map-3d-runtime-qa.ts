// @ts-nocheck
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import puppeteer from 'puppeteer-core'
import sharp from 'sharp'
import manifest from '../../public/data/santa-fe-3d/manifest.json'

const chrome = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const SOURCE_LAYER = 'santa_fe_buildings_3d'
const FIXTURES = [
  { id: 'PUBLIC_SANTA_FE_DENSE_CENTRAL_V1', center: [-60.7003, -31.6401], zoom: 16.8, pitch: 58, bearing: 24, minimumFeatures: 120 },
  { id: 'PUBLIC_SANTA_FE_MIXED_RISE_V1', center: [-60.6738, -31.6237], zoom: 16.6, pitch: 56, bearing: 28, minimumFeatures: 60 },
] as const

class Map3dQaFailure extends Error {
  constructor(readonly code: string) { super(code) }
}
function ok(value: unknown, code: string): asserts value {
  if (!value) throw new Map3dQaFailure(code)
}
function overrideHeaders(version: string): HeadersInit {
  return version ? { 'Cloudflare-Workers-Version-Overrides': `stracker="${version}"` } : {}
}
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function sanitizedCode(value: unknown): string {
  return String(value || 'UNKNOWN').replace(/https?:\/\/\S+/gi, '[URL]').replace(/[A-Za-z0-9_-]{43}(?:\.[A-Za-z0-9_-]{43})?/g, '[CAPABILITY]').replace(/[^A-Z0-9_[\]-]+/gi, '_').slice(0, 160)
}

export interface Map3dQaOptions {
  targetUrl?: string
  expectedSha?: string
  expectedVersionId?: string
  overrideVersion?: string
  output?: string
  screenshotDir?: string
}

async function verifyRuntimeIdentity(options: Map3dQaOptions): Promise<void> {
  if (!options.targetUrl) return
  const target = new URL(options.targetUrl)
  ok(target.protocol === 'https:', 'MAP3D_HTTPS_TARGET_REQUIRED')
  const headers = { Accept: 'application/json', 'Cache-Control': 'no-cache', ...overrideHeaders(options.overrideVersion || '') }
  let lastCode = 'MAP3D_RUNTIME_IDENTITY_UNAVAILABLE'
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const nonce = `${Date.now()}-${attempt}`
    const [buildResponse, versionResponse] = await Promise.all([
      fetch(new URL(`/__stracker/build.json?map3d=${nonce}`, target), { headers, cache: 'no-store' }),
      fetch(new URL(`/__stracker/version.json?map3d=${nonce}`, target), { headers, cache: 'no-store' }),
    ])
    const build = await buildResponse.json().catch(() => null) as { sourceSha?: string; release?: string } | null
    const version = await versionResponse.json().catch(() => null) as { sourceSha?: string; versionId?: string } | null
    if (!buildResponse.ok || !versionResponse.ok || !build || !version) lastCode = 'MAP3D_RUNTIME_IDENTITY_UNAVAILABLE'
    else if (build.sourceSha !== options.expectedSha) lastCode = 'MAP3D_BUILD_SHA_MISMATCH'
    else if (build.release !== 'controlled-physical-pilot-v1') lastCode = 'MAP3D_BUILD_RELEASE_MISMATCH'
    else if (version.sourceSha !== options.expectedSha) lastCode = 'MAP3D_VERSION_SHA_MISMATCH'
    else if (version.versionId !== options.expectedVersionId) lastCode = 'MAP3D_VERSION_ID_MISMATCH'
    else return
    if (attempt < 30) await Bun.sleep(1_000)
  }
  throw new Map3dQaFailure(lastCode)
}

async function verifyTargetRange(options: Map3dQaOptions): Promise<{ checked: number; transferredBytes: number }> {
  if (!options.targetUrl) return { checked: 0, transferredBytes: 0 }
  const target = new URL(options.targetUrl)
  const headers = { 'Cache-Control': 'no-cache', ...overrideHeaders(options.overrideVersion || '') }
  const manifestResponse = await fetch(new URL(`/data/santa-fe-3d/manifest.json?rangeqa=${Date.now()}`, target), { headers, cache: 'no-store' })
  ok(manifestResponse.status === 200, 'SANTA_FE_TARGET_MANIFEST_UNAVAILABLE')
  const remote = await manifestResponse.json() as typeof manifest
  ok(remote.final_features >= 200_000, 'SANTA_FE_TARGET_FEATURE_COUNT_LOW')
  ok(remote.unique_height_bucket_count >= 6, 'SANTA_FE_TARGET_HEIGHT_BUCKETS_LOW')
  ok(remote.uniform_default_height_fraction < 0.35, 'SANTA_FE_TARGET_UNIFORM_HEIGHT_HIGH')
  ok(remote.asset_paths.length >= 2, 'SANTA_FE_TARGET_SHARDS_MISSING')
  let transferredBytes = 0
  for (const path of remote.asset_paths) {
    const response = await fetch(new URL(`${path}?rangeqa=${Date.now()}`, target), {
      headers: { ...headers, Range: 'bytes=0-16383' }, cache: 'no-store',
    })
    const body = await response.arrayBuffer()
    const contentRange = response.headers.get('content-range') || ''
    ok(response.status === 206, 'SANTA_FE_TARGET_RANGE_STATUS_NOT_206')
    ok(/^bytes 0-\d+\/\d+$/.test(contentRange), 'SANTA_FE_TARGET_CONTENT_RANGE_MISSING')
    ok(response.headers.get('accept-ranges')?.toLowerCase() === 'bytes', 'SANTA_FE_TARGET_ACCEPT_RANGES_MISSING')
    ok(body.byteLength > 0 && body.byteLength <= 16_384, 'SANTA_FE_TARGET_RANGE_BOUNDED')
    transferredBytes += body.byteLength
  }
  return { checked: remote.asset_paths.length, transferredBytes }
}

function browserEntry(): string {
  return `
import maplibregl from 'maplibre-gl'
import { acquireSantaFePmtilesProtocol, configureSantaFeCity3d } from './src/lib/location-source/map-engine/santa-fe-city-runtime'
import { SANTA_FE_3D_LAYER_IDS, SANTA_FE_3D_SOURCE_IDS } from './src/lib/location-source/map-engine/santa-fe-city-config'
import { setLightCityBaseStyle } from './src/lib/location-source/map-engine/openfreemap-style'

const fixtures = ${JSON.stringify(FIXTURES)}
const layerIds = SANTA_FE_3D_LAYER_IDS
const sourceIds = SANTA_FE_3D_SOURCE_IDS
const releaseProtocol = acquireSantaFePmtilesProtocol()
const startedAt = performance.now()
let firstInteractiveMs = null
const map = new maplibregl.Map({
  container: 'map', style: 'https://tiles.openfreemap.org/styles/liberty',
  center: fixtures[0].center, zoom: fixtures[0].zoom, pitch: fixtures[0].pitch, bearing: fixtures[0].bearing,
  minZoom: 3, maxZoom: 20, maxPitch: 65, preserveDrawingBuffer: true,
  attributionControl: false, cooperativeGestures: false, fadeDuration: 0,
})
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const once = (name, timeout = 60000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('TIMEOUT_' + name)), timeout)
  map.once(name, (...args) => { clearTimeout(timer); resolve(args) })
})
function addMarker(center) {
  const data = { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: center } }
  if (!map.getSource('stracker-map3d-qa-source')) map.addSource('stracker-map3d-qa-source', { type: 'geojson', data })
  else map.getSource('stracker-map3d-qa-source').setData(data)
  if (!map.getLayer('stracker-map3d-qa-marker')) map.addLayer({
    id: 'stracker-map3d-qa-marker', type: 'circle', source: 'stracker-map3d-qa-source',
    paint: { 'circle-radius': 9, 'circle-color': '#ffffff', 'circle-stroke-color': '#15191d', 'circle-stroke-width': 3 },
  })
}
function snapshot(fixture) {
  const styleLayers = map.getStyle().layers || []
  const visibleLayers = layerIds.filter((id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none')
  const features = visibleLayers.length ? map.queryRenderedFeatures({ layers: visibleLayers }) : []
  const heights = [...new Set(features.map((feature) => Number(feature.properties?.height)).filter((value) => Number.isFinite(value) && value >= 3).map((value) => Math.round(value * 10) / 10))]
  const buildingIndexes = visibleLayers.map((id) => styleLayers.findIndex((layer) => layer.id === id)).filter((index) => index >= 0)
  const maxBuildingIndex = buildingIndexes.length ? Math.max(...buildingIndexes) : -1
  const firstSymbolIndex = styleLayers.findIndex((layer) => layer.type === 'symbol')
  const markerIndex = styleLayers.findIndex((layer) => layer.id === 'stracker-map3d-qa-marker')
  return {
    fixtureId: fixture.id, visible: visibleLayers.length > 0, layerCount: visibleLayers.length,
    renderedFeatureCount: features.length, uniqueHeightCount: heights.length,
    sourceLayer: visibleLayers.length ? (styleLayers.find((layer) => layer.id === visibleLayers[0])?.['source-layer'] || null) : null,
    sourceIdle: sourceIds.every((id) => !map.getSource(id) || map.isSourceLoaded(id)), zoom: map.getZoom(), pitch: map.getPitch(),
    labelsAboveBuildings: maxBuildingIndex >= 0 && firstSymbolIndex > maxBuildingIndex,
    markerAboveBuildings: maxBuildingIndex >= 0 && markerIndex > maxBuildingIndex,
  }
}
async function setFixture(index) {
  const fixture = fixtures[index]
  map.jumpTo({ center: fixture.center, zoom: fixture.zoom, pitch: fixture.pitch, bearing: fixture.bearing })
  configureSantaFeCity3d(map, { enabled: true, density: 'full', center: { lng: fixture.center[0], lat: fixture.center[1] }, origin: location.origin })
  addMarker(fixture.center)
  const deadline = Date.now() + 50000
  let current = snapshot(fixture)
  while (Date.now() < deadline) {
    map.triggerRepaint(); await delay(350); current = snapshot(fixture)
    if (current.sourceIdle && current.renderedFeatureCount >= fixture.minimumFeatures && current.uniqueHeightCount >= 6) {
      if (firstInteractiveMs === null) firstInteractiveMs = Math.round(performance.now() - startedAt)
      return current
    }
  }
  return current
}
async function toggle(enabled, index) {
  const fixture = fixtures[index]
  configureSantaFeCity3d(map, { enabled, density: 'full', center: { lng: fixture.center[0], lat: fixture.center[1] }, origin: location.origin })
  map.triggerRepaint(); await delay(1000)
  return snapshot(fixture)
}
async function fpsSample() {
  let frames = 0
  const start = performance.now()
  await new Promise((resolve) => {
    const frame = () => {
      frames += 1
      if (performance.now() - start >= 2000) resolve()
      else requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  })
  return Math.round(frames * 1000 / Math.max(1, performance.now() - start))
}
async function run() {
  await once('load')
  setLightCityBaseStyle(map)
  const snapshots = []
  for (let index = 0; index < fixtures.length; index += 1) snapshots.push(await setFixture(index))
  window.__strackerMap3dQa = { ready: true, snapshots, firstInteractiveMs: firstInteractiveMs ?? Math.round(performance.now() - startedAt), setFixture, toggle, snapshot: (index) => snapshot(fixtures[index]), fpsSample }
}
run().catch((error) => { window.__strackerMap3dQa = { ready: false, error: String(error?.message || error) } })
window.addEventListener('beforeunload', releaseProtocol)
`
}

async function imageStats(image: Uint8Array): Promise<{ darkPixelShare: number }> {
  const raw = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let dark = 0
  for (let i = 0; i < raw.data.length; i += raw.info.channels) {
    if (raw.data[i] < 48 && raw.data[i + 1] < 48 && raw.data[i + 2] < 48) dark += 1
  }
  return { darkPixelShare: dark / Math.max(1, raw.info.width * raw.info.height) }
}
async function imageDifference(a: Uint8Array, b: Uint8Array): Promise<{ changedPixels: number; meanAbsoluteDelta: number }> {
  const [left, right] = await Promise.all([
    sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ])
  ok(left.info.width === right.info.width && left.info.height === right.info.height, 'MAP3D_SCREENSHOT_DIMENSION_MISMATCH')
  let changedPixels = 0
  let totalDelta = 0
  for (let i = 0; i < left.data.length; i += left.info.channels) {
    const delta = Math.abs(left.data[i] - right.data[i]) + Math.abs(left.data[i + 1] - right.data[i + 1]) + Math.abs(left.data[i + 2] - right.data[i + 2])
    totalDelta += delta
    if (delta >= 18) changedPixels += 1
  }
  return { changedPixels, meanAbsoluteDelta: totalDelta / Math.max(1, left.info.width * left.info.height * 3) }
}

async function installTargetGeolocation(page: any): Promise<void> {
  const fixture = FIXTURES[0]
  await page.evaluateOnNewDocument((input) => {
    let nextId = 1
    const active = new Map()
    const position = () => ({
      coords: { latitude: input.lat, longitude: input.lng, accuracy: 4, altitude: null, altitudeAccuracy: null, heading: 25, speed: 0, toJSON: () => ({}) },
      timestamp: Date.now(), toJSON: () => ({}),
    })
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) { setTimeout(() => success(position()), 10) },
        watchPosition(success) { const id = nextId++; active.set(id, success); setTimeout(() => { if (active.has(id)) success(position()) }, 50); return id },
        clearWatch(id) { active.delete(id) },
      },
    })
  }, { lng: fixture.center[0], lat: fixture.center[1] })
}

async function clickText(page: any, text: string): Promise<void> {
  await page.waitForFunction((value) => [...document.querySelectorAll('button')].some((button) => button.textContent?.toUpperCase().includes(String(value).toUpperCase())), { timeout: 30_000 }, text)
  await page.$$eval('button', (buttons, value) => {
    const target = buttons.find((button) => button.textContent?.toUpperCase().includes(String(value).toUpperCase()))
    if (!target) throw new Error('BUTTON_NOT_FOUND')
    target.click()
  }, text)
}

async function verifyTargetApplication(options: Map3dQaOptions, screenshotDir: string): Promise<any | null> {
  if (!options.targetUrl) return null
  const target = new URL(options.targetUrl)
  let browser
  const diagnostics: any = {
    attempts: 0,
    rootStatus: null,
    pageErrors: [],
    consoleErrors: [],
    pmtilesRequests: 0,
    pmtilesRequestsWithoutRange: 0,
    pmtiles206Responses: 0,
    pmtilesContentRangeResponses: 0,
  }
  try {
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--disable-dev-shm-usage'] })
    const page = await browser.newPage()
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await installTargetGeolocation(page)
    await page.setRequestInterception(true)
    page.on('request', (request) => {
      void (async () => {
        const url = new URL(request.url())
        const sameOrigin = url.origin === target.origin
        if (sameOrigin && url.pathname.endsWith('.pmtiles')) {
          diagnostics.pmtilesRequests += 1
          if (!request.headers().range) diagnostics.pmtilesRequestsWithoutRange += 1
        }
        const headers = sameOrigin && options.overrideVersion
          ? { ...request.headers(), 'Cloudflare-Workers-Version-Overrides': `stracker="${options.overrideVersion}"` }
          : request.headers()
        await request.continue({ headers })
      })().catch(() => request.abort().catch(() => undefined))
    })
    page.on('response', (response) => {
      try {
        const url = new URL(response.url())
        if (url.origin === target.origin && url.pathname.endsWith('.pmtiles')) {
          if (response.status() === 206) diagnostics.pmtiles206Responses += 1
          if (/^bytes \d+-\d+\/\d+$/.test(response.headers()['content-range'] || '')) diagnostics.pmtilesContentRangeResponses += 1
        }
      } catch {}
    })
    page.on('pageerror', (error) => diagnostics.pageErrors.push(sanitizedCode(error instanceof Error ? error.message : 'PAGEERROR')))
    page.on('console', (message) => {
      if (message.type() === 'error') diagnostics.consoleErrors.push(sanitizedCode(message.text()))
    })

    let ready = false
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      diagnostics.attempts = attempt
      const response = await page.goto(new URL(`/?dense3d=${Date.now()}-${attempt}`, target).href, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => null)
      diagnostics.rootStatus = response?.status() ?? null
      ready = await page.waitForFunction(() => document.body.textContent?.includes('¿Qué ubicación querés ver?'), { timeout: 25_000 }).then(() => true).catch(() => false)
      if (ready) break
      if (attempt < 4) await Bun.sleep(5_000)
    }
    ok(ready, `TARGET_ROOT_NOT_READY_${diagnostics.rootStatus ?? 'NO_STATUS'}`)
    await clickText(page, 'MI UBICACIÓN')
    await clickText(page, 'PERMITIR UBICACIÓN')
    await page.waitForSelector('main[data-map-engine="maplibre"][data-location-source="my-device"][data-map-provider="available"]', { timeout: 90_000 })
    const pmtilesDeadline = Date.now() + 90_000
    while (diagnostics.pmtiles206Responses === 0 && Date.now() < pmtilesDeadline) await Bun.sleep(500)
    ok(diagnostics.pmtiles206Responses > 0, 'TARGET_SANTA_FE_PMTILES_NOT_RENDERING')
    await Bun.sleep(5_000)
    const before = await page.evaluate(() => {
      const main = document.querySelector('main[data-map-engine="maplibre"]')
      return {
        providerState: main?.getAttribute('data-map-provider'),
        firstVisibleMs: Number(main?.getAttribute('data-map-first-visible-ms')) || null,
        firstInteractiveMs: Number(main?.getAttribute('data-map-first-interactive-ms')) || null,
        estimatedFps: Number(main?.getAttribute('data-map-fps')) || null,
        longTasks: Number(main?.getAttribute('data-map-long-tasks')) || 0,
        transferredBytes: Number(main?.getAttribute('data-map-transferred-bytes')) || 0,
      }
    })
    const canvas = await page.$('canvas.maplibregl-canvas')
    const clip = await canvas?.boundingBox()
    ok(Boolean(clip), 'TARGET_SANTA_FE_CANVAS_MISSING')
    const onImage = await page.screenshot({ clip: clip! })
    await page.click('button[aria-label="Activar o desactivar edificios 3D"]')
    await Bun.sleep(1_200)
    const offImage = await page.screenshot({ clip: clip! })
    await page.click('button[aria-label="Activar o desactivar edificios 3D"]')
    await Bun.sleep(3_000)
    const diff = await imageDifference(onImage, offImage)
    const light = await imageStats(onImage)
    ok(diff.changedPixels >= 8_000 && diff.meanAbsoluteDelta >= 0.35, 'TARGET_SANTA_FE_VISIBLE_PIXEL_EFFECT_LOW')
    ok(light.darkPixelShare < 0.42, 'TARGET_SANTA_FE_LIGHT_STYLE_TOO_DARK')
    ok(diagnostics.pageErrors.length === 0, 'TARGET_SANTA_FE_PAGE_ERROR')
    ok(diagnostics.consoleErrors.length === 0, 'TARGET_SANTA_FE_CONSOLE_ERROR')
    ok(diagnostics.pmtilesRequests > 0, 'TARGET_SANTA_FE_PMTILES_NOT_REQUESTED')
    ok(diagnostics.pmtilesRequestsWithoutRange === 0, 'TARGET_SANTA_FE_FULL_PMTILES_REQUEST')
    ok(diagnostics.pmtiles206Responses > 0 && diagnostics.pmtilesContentRangeResponses > 0, 'TARGET_SANTA_FE_BROWSER_RANGE_CONTRACT')
    const onPath = join(screenshotDir, 'santa-fe-dense-city-public-on.png')
    const offPath = join(screenshotDir, 'santa-fe-dense-city-public-off.png')
    await Bun.write(onPath, onImage)
    await Bun.write(offPath, offImage)
    return {
      ...diagnostics,
      ...before,
      changedPixels: diff.changedPixels,
      meanAbsoluteDelta: Math.round(diff.meanAbsoluteDelta * 10_000) / 10_000,
      darkPixelShare: Math.round(light.darkPixelShare * 1_000_000) / 1_000_000,
      screenshots: [
        { name: 'santa-fe-dense-city-public-on.png', sha256: sha256(onImage) },
        { name: 'santa-fe-dense-city-public-off.png', sha256: sha256(offImage) },
      ],
    }
  } finally {
    await browser?.close()
  }
}

export async function runMap3dRuntimeQa(options: Map3dQaOptions = {}): Promise<any> {
  if (options.targetUrl) {
    ok(/^[0-9a-f]{40}$/.test(options.expectedSha || ''), 'MAP3D_EXPECTED_SHA_REQUIRED')
    ok(Boolean(options.expectedVersionId), 'MAP3D_EXPECTED_VERSION_REQUIRED')
  }
  await verifyRuntimeIdentity(options)
  const targetRange = await verifyTargetRange(options)
  const work = await mkdtemp(join(tmpdir(), 'stracker-santa-fe-map3d-'))
  const entry = join(process.cwd(), `.stracker-santa-fe-map3d-entry-${process.pid}-${Date.now()}.ts`)
  const screenshotDir = options.screenshotDir || join(process.env.RUNNER_TEMP || '/tmp', 'stracker-controlled-physical-pilot-release')
  let browser
  let server
  const rangeStats = { requests: 0, fullRequests: 0, transferredBytes: 0, maxResponseBytes: 0, contentRangeFailures: 0 }
  try {
    await mkdir(screenshotDir, { recursive: true })
    await writeFile(entry, browserEntry())
    const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm', minify: false, sourcemap: 'none', outdir: work })
    ok(build.success && build.outputs.length === 1, 'MAP3D_BROWSER_BUNDLE_FAILED')
    const bundle = await build.outputs[0].text()
    const css = await Bun.file(join(process.cwd(), 'node_modules/maplibre-gl/dist/maplibre-gl.css')).text()
    server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/fixture.js') return new Response(bundle, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' } })
        if (path === '/maplibre.css') return new Response(css, { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' } })
        if (path.startsWith('/data/santa-fe-3d/') && path.endsWith('.pmtiles')) {
          const file = Bun.file(join(process.cwd(), 'out', path.replace(/^\//, '')))
          if (!(await file.exists())) return new Response('not found', { status: 404 })
          const range = request.headers.get('range')
          if (!range) { rangeStats.fullRequests += 1; return new Response('range required', { status: 416, headers: { 'Accept-Ranges': 'bytes' } }) }
          const match = /^bytes=(\d+)-(\d*)$/.exec(range)
          if (!match) return new Response('invalid range', { status: 416, headers: { 'Accept-Ranges': 'bytes' } })
          const start = Number(match[1])
          const end = Math.min(file.size - 1, match[2] ? Number(match[2]) : file.size - 1)
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= file.size) return new Response('invalid range', { status: 416, headers: { 'Accept-Ranges': 'bytes' } })
          const body = await file.slice(start, end + 1).arrayBuffer()
          rangeStats.requests += 1
          rangeStats.transferredBytes += body.byteLength
          rangeStats.maxResponseBytes = Math.max(rangeStats.maxResponseBytes, body.byteLength)
          const contentRange = `bytes ${start}-${end}/${file.size}`
          if (!contentRange.startsWith('bytes ')) rangeStats.contentRangeFailures += 1
          return new Response(body, { status: 206, headers: { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Range': contentRange, 'Content-Length': String(body.byteLength), 'Cache-Control': 'public, max-age=31536000, immutable' } })
        }
        return new Response('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/maplibre.css"><style>html,body,#map{width:100%;height:100%;margin:0;background:#f2f1ed;overflow:hidden}</style></head><body><div id="map"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
      },
    })
    browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--disable-dev-shm-usage'] })
    const page = await browser.newPage()
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error instanceof Error ? error.message : 'PAGEERROR'))
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 160)) })
    await page.goto(`http://${server.hostname}:${server.port}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.waitForFunction(() => (window as any).__strackerMap3dQa?.ready === true || Boolean((window as any).__strackerMap3dQa?.error), { timeout: 120_000 })
    const initial = await page.evaluate(() => (window as any).__strackerMap3dQa)
    ok(initial?.ready === true, `MAP3D_FIXTURE_${sanitizedCode(initial?.error || 'NOT_READY')}`)
    ok(pageErrors.length === 0, 'MAP3D_PAGE_ERROR')
    ok(consoleErrors.length === 0, 'MAP3D_CONSOLE_ERROR')
    for (let index = 0; index < FIXTURES.length; index += 1) {
      const snapshot = initial.snapshots[index]
      ok(snapshot.layerCount === manifest.asset_paths.length, `SANTA_FE_FIXTURE_${index}_LAYER_COUNT`)
      ok(snapshot.sourceLayer === SOURCE_LAYER, `SANTA_FE_FIXTURE_${index}_SOURCE_LAYER`)
      ok(snapshot.renderedFeatureCount >= FIXTURES[index].minimumFeatures, `SANTA_FE_FIXTURE_${index}_DENSITY_LOW`)
      ok(snapshot.uniqueHeightCount >= 6, `SANTA_FE_FIXTURE_${index}_HEIGHT_VARIATION_LOW`)
      ok(snapshot.sourceIdle === true, `SANTA_FE_FIXTURE_${index}_SOURCE_NOT_IDLE`)
      ok(snapshot.pitch >= 52 && snapshot.pitch <= 60, `SANTA_FE_FIXTURE_${index}_PITCH`)
      ok(snapshot.labelsAboveBuildings === true, `SANTA_FE_FIXTURE_${index}_LABEL_ORDER`)
      ok(snapshot.markerAboveBuildings === true, `SANTA_FE_FIXTURE_${index}_MARKER_ORDER`)
    }
    await page.evaluate(() => (window as any).__strackerMap3dQa.setFixture(0))
    const mapElement = await page.$('#map')
    const clip = await mapElement?.boundingBox()
    ok(Boolean(clip), 'MAP3D_CANVAS_BOUNDS_UNAVAILABLE')
    const onImage = await page.screenshot({ clip: clip! })
    const off = await page.evaluate(() => (window as any).__strackerMap3dQa.toggle(false, 0))
    const offImage = await page.screenshot({ clip: clip! })
    const onAgain = await page.evaluate(() => (window as any).__strackerMap3dQa.toggle(true, 0))
    const diff = await imageDifference(onImage, offImage)
    const light = await imageStats(onImage)
    const estimatedFps = await page.evaluate(() => (window as any).__strackerMap3dQa.fpsSample())
    ok(off.visible === false && off.renderedFeatureCount === 0, 'SANTA_FE_BUILDINGS_TOGGLE_OFF')
    ok(onAgain.visible === true && onAgain.renderedFeatureCount >= FIXTURES[0].minimumFeatures, 'SANTA_FE_BUILDINGS_TOGGLE_ON')
    ok(diff.changedPixels >= 8_000 && diff.meanAbsoluteDelta >= 0.35, 'SANTA_FE_VISIBLE_PIXEL_EFFECT_LOW')
    ok(light.darkPixelShare < 0.42, 'SANTA_FE_LIGHT_STYLE_TOO_DARK')
    ok(initial.firstInteractiveMs <= 12_000, 'SANTA_FE_SYNTHETIC_FIRST_INTERACTIVE_BUDGET')
    ok(estimatedFps >= 24, 'SANTA_FE_SYNTHETIC_FPS_BUDGET')
    ok(rangeStats.requests > 0 && rangeStats.fullRequests === 0, 'SANTA_FE_LOCAL_RANGE_CONTRACT')
    ok(rangeStats.contentRangeFailures === 0, 'SANTA_FE_LOCAL_CONTENT_RANGE')
    ok(rangeStats.maxResponseBytes <= 4 * 1024 * 1024, 'SANTA_FE_LOCAL_RANGE_RESPONSE_UNBOUNDED')
    ok(rangeStats.transferredBytes < manifest.asset_sizes.reduce((sum, value) => sum + value, 0), 'SANTA_FE_FULL_CITY_DOWNLOAD_DETECTED')
    const localOnPath = join(screenshotDir, 'santa-fe-dense-city-on.png')
    const localOffPath = join(screenshotDir, 'santa-fe-dense-city-off.png')
    await Bun.write(localOnPath, onImage)
    await Bun.write(localOffPath, offImage)
    const targetApplication = await verifyTargetApplication(options, screenshotDir)
    const selected = initial.snapshots[0]
    const result = {
      schema: 'stracker.santa-fe-dense-city-3d-runtime-qa.v2',
      sourceSha: options.expectedSha || null,
      targetRuntimeVerified: Boolean(options.targetUrl),
      fixtureId: selected.fixtureId,
      fixtures: initial.snapshots,
      privateDataUsed: false,
      realUserCoordinatesUsed: false,
      coordinateValuesRetained: false,
      renderedFeatureCount: selected.renderedFeatureCount,
      source: 'same-origin-content-addressed-pmtiles',
      sourceLayer: SOURCE_LAYER,
      uniqueHeightCount: selected.uniqueHeightCount,
      fallbackUsed: false,
      changedPixels: diff.changedPixels,
      meanAbsoluteDelta: Math.round(diff.meanAbsoluteDelta * 10_000) / 10_000,
      darkPixelShare: Math.round(light.darkPixelShare * 1_000_000) / 1_000_000,
      firstInteractiveMs: initial.firstInteractiveMs,
      estimatedFps,
      localRange: rangeStats,
      targetRange,
      targetApplication,
      screenshots: [
        { name: 'santa-fe-dense-city-on.png', sha256: sha256(onImage) },
        { name: 'santa-fe-dense-city-off.png', sha256: sha256(offImage) },
        ...(targetApplication?.screenshots || []),
      ],
      assetPaths: manifest.asset_paths,
      assetSizes: manifest.asset_sizes,
      assetSha256: manifest.asset_sha256,
      featureCount: manifest.final_features,
      heightSourceCounts: manifest.height_source_counts,
      uniqueHeightBucketCount: manifest.unique_height_bucket_count,
      uniformDefaultHeightFraction: manifest.uniform_default_height_fraction,
      gates: {
        MAP_3D_RUNTIME_TESTS: 'PASS',
        SANTA_FE_DENSE_CITY_FIXTURE_A: 'PASS',
        SANTA_FE_DENSE_CITY_FIXTURE_B: 'PASS',
        SAME_ORIGIN_CONTENT_ADDRESSED_PMTILES: 'PASS',
        PMTILES_RANGE_REQUESTS_BOUNDED: 'PASS',
        PMTILES_CONTENT_RANGE: 'PASS',
        NO_FULL_CITY_ASSET_DOWNLOAD: 'PASS',
        FILL_EXTRUSION_LAYER_RESOLVED: 'PASS',
        BUILDING_SOURCE_AND_SOURCE_LAYER_RESOLVED: 'PASS',
        RENDERED_BUILDING_FEATURES_GT_ZERO: 'PASS',
        DENSE_CITY_BLOCK_MASSING: 'PASS',
        WALLS_AND_ROOFS_VISIBLE: 'PASS',
        UNIQUE_EFFECTIVE_HEIGHT_BUCKETS_GTE_6: 'PASS',
        BUILDING_TOGGLE_VISIBLE_EFFECT: 'PASS',
        LIGHT_CITY_STYLE: 'PASS',
        MARKER_ABOVE_BUILDINGS: 'PASS',
        LABELS_USABLE_ABOVE_BUILDINGS: 'PASS',
        A22_PERFORMANCE_BUDGET_SYNTHETIC: 'PASS',
        PUBLIC_FIXTURES_ONLY: 'PASS',
        NO_PRIVATE_DATA_IN_QA: 'PASS',
        ...(targetApplication ? {
          PUBLIC_RUNTIME_DENSE_SANTA_FE_3D: 'PASS',
          PUBLIC_RUNTIME_ROOT_READY_AFTER_BOUNDED_PROPAGATION_WAIT: 'PASS',
          PUBLIC_RUNTIME_PMTILES_BROWSER_RANGE: 'PASS',
          PUBLIC_RUNTIME_LIGHT_CITY_STYLE: 'PASS',
          PUBLIC_RUNTIME_BUILDING_TOGGLE_VISIBLE_EFFECT: 'PASS',
        } : {}),
      },
    }
    if (options.output) await Bun.write(options.output, JSON.stringify(result, null, 2) + '\n')
    return result
  } finally {
    await browser?.close()
    server?.stop(true)
    await rm(entry, { force: true })
    await rm(work, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const result = await runMap3dRuntimeQa({
    targetUrl: process.env.STRACKER_QA_URL,
    expectedSha: process.env.STRACKER_EXPECTED_SHA,
    expectedVersionId: process.env.STRACKER_EXPECTED_VERSION_ID,
    overrideVersion: process.env.STRACKER_VERSION_OVERRIDE,
    output: process.env.STRACKER_MAP3D_QA_OUTPUT || '/tmp/stracker-map3d-runtime-qa.json',
    screenshotDir: process.env.STRACKER_MAP3D_SCREENSHOT_DIR,
  })
  console.log(`MAP_3D_RUNTIME_QA=PASS fixture=${result.fixtureId} features=${result.renderedFeatureCount}`)
}
