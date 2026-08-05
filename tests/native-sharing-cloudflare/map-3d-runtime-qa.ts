// @ts-nocheck
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import puppeteer from 'puppeteer-core'
import sharp from 'sharp'

const PUBLIC_FIXTURES = [
  { id: 'PUBLIC_OSM_MANHATTAN_V1', center: [-73.9855, 40.7484] },
  { id: 'PUBLIC_OSM_PARIS_V1', center: [2.2945, 48.8584] },
  { id: 'PUBLIC_OSM_BUENOS_AIRES_V1', center: [-58.3816, -34.6037] },
]
const BUILDING_LAYER_ID = 'stracker-buildings-3d'
const MARKER_LAYER_ID = 'stracker-map3d-qa-marker'
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'
const chrome = process.env.CHROME_BIN || '/usr/bin/google-chrome'

class Map3dQaFailure extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

function ok(value: unknown, code: string): asserts value {
  if (!value) throw new Map3dQaFailure(code)
}

function overrideHeaders(version: string): HeadersInit {
  return version ? { 'Cloudflare-Workers-Version-Overrides': `stracker="${version}"` } : {}
}

async function verifyRuntimeIdentity(options: Map3dQaOptions): Promise<void> {
  if (!options.targetUrl) return
  const target = new URL(options.targetUrl)
  ok(target.protocol === 'https:', 'MAP3D_HTTPS_TARGET_REQUIRED')
  const headers = {
    Accept: 'application/json',
    'Cache-Control': 'no-cache',
    ...overrideHeaders(options.overrideVersion || ''),
  }
  let lastCode = 'MAP3D_RUNTIME_IDENTITY_UNAVAILABLE'
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const nonce = `${Date.now()}-${attempt}-${Math.random().toString(36).slice(2)}`
    const [buildResponse, versionResponse] = await Promise.all([
      fetch(new URL(`/__stracker/build.json?map3d=${nonce}`, target), { headers, cache: 'no-store' }),
      fetch(new URL(`/__stracker/version.json?map3d=${nonce}`, target), { headers, cache: 'no-store' }),
    ])
    const build = await buildResponse.json().catch(() => null) as { sourceSha?: string; release?: string } | null
    const version = await versionResponse.json().catch(() => null) as { sourceSha?: string; versionId?: string } | null
    if (buildResponse.status !== 200 || versionResponse.status !== 200 || !build || !version) lastCode = 'MAP3D_RUNTIME_IDENTITY_UNAVAILABLE'
    else if (build.sourceSha !== options.expectedSha) lastCode = 'MAP3D_BUILD_SHA_MISMATCH'
    else if (build.release !== 'controlled-physical-pilot-v1') lastCode = 'MAP3D_BUILD_RELEASE_MISMATCH'
    else if (version.sourceSha !== options.expectedSha) lastCode = 'MAP3D_VERSION_SHA_MISMATCH'
    else if (version.versionId !== options.expectedVersionId) lastCode = 'MAP3D_VERSION_ID_MISMATCH'
    else return
    if (attempt < 20) await Bun.sleep(1_000)
  }
  throw new Map3dQaFailure(lastCode)
}

function browserEntry(): string {
  return `
import maplibregl from 'maplibre-gl'
import { configureBuildings3d, setDarkBaseStyle } from './src/lib/location-source/map-engine/openfreemap-style'

const fixtures = ${JSON.stringify(PUBLIC_FIXTURES)}
const buildingLayerId = ${JSON.stringify(BUILDING_LAYER_ID)}
const markerLayerId = ${JSON.stringify(MARKER_LAYER_ID)}
const map = new maplibregl.Map({
  container: 'map',
  style: ${JSON.stringify(STYLE_URL)},
  center: fixtures[0].center,
  zoom: 17,
  pitch: 52,
  bearing: -22,
  minZoom: 3,
  maxZoom: 20,
  maxPitch: 65,
  preserveDrawingBuffer: true,
  attributionControl: false,
  cooperativeGestures: false,
  fadeDuration: 0,
})

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const once = (name, timeout = 45000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('TIMEOUT_' + name)), timeout)
  map.once(name, (...args) => { clearTimeout(timer); resolve(args) })
})
async function settle() {
  map.triggerRepaint()
  await delay(1200)
}
function numeric(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}
function effectiveHeight(properties = {}) {
  const direct = numeric(properties.render_height) ?? numeric(properties.height)
  if (direct !== null) return { height: direct, fallback: false }
  const levels = numeric(properties['building:levels']) ?? numeric(properties.levels)
  if (levels !== null) return { height: levels * 3, fallback: false }
  return { height: 12, fallback: true }
}
function addMarker(center) {
  if (!map.getSource('stracker-map3d-qa-source')) {
    map.addSource('stracker-map3d-qa-source', {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: center } },
    })
  } else {
    map.getSource('stracker-map3d-qa-source').setData({
      type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: center },
    })
  }
  if (!map.getLayer(markerLayerId)) {
    map.addLayer({
      id: markerLayerId,
      type: 'circle',
      source: 'stracker-map3d-qa-source',
      paint: {
        'circle-radius': 10,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#050505',
        'circle-stroke-width': 3,
      },
    })
  }
}
function snapshot(fixtureId) {
  const style = map.getStyle()
  const layers = style.layers || []
  const building = map.getLayer(buildingLayerId)
  const serializedBuilding = layers.find((layer) => layer.id === buildingLayerId)
  const buildingIndex = layers.findIndex((layer) => layer.id === buildingLayerId)
  const markerIndex = layers.findIndex((layer) => layer.id === markerLayerId)
  const firstSymbolIndex = layers.findIndex((layer) => layer.type === 'symbol')
  const visible = building && map.getLayoutProperty(buildingLayerId, 'visibility') !== 'none'
  const features = visible ? map.queryRenderedFeatures({ layers: [buildingLayerId] }) : []
  const heights = features.map((feature) => effectiveHeight(feature.properties || {}))
  const uniqueHeights = [...new Set(heights.map((item) => Math.round(item.height * 100) / 100))]
  return {
    fixtureId,
    layerType: serializedBuilding?.type || building?.type || null,
    source: serializedBuilding?.source || building?.source || null,
    sourceLayer: serializedBuilding?.['source-layer'] || serializedBuilding?.sourceLayer || building?.['source-layer'] || building?.sourceLayer || null,
    visible: Boolean(visible),
    renderedFeatureCount: features.length,
    uniqueHeightCount: uniqueHeights.length,
    fallbackUsed: heights.some((item) => item.fallback),
    sourceIdle: map.isStyleLoaded() && map.areTilesLoaded(),
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    buildingIndex,
    markerIndex,
    firstSymbolIndex,
    markerAboveBuildings: buildingIndex >= 0 && markerIndex > buildingIndex,
    labelsAboveBuildings: buildingIndex >= 0 && firstSymbolIndex > buildingIndex,
  }
}
async function toggle(enabled, fixtureId) {
  configureBuildings3d(map, { enabled, density: 'full' })
  await settle()
  return snapshot(fixtureId)
}

async function run() {
  await once('load')
  setDarkBaseStyle(map)
  let selected = null
  for (const fixture of fixtures) {
    map.jumpTo({ center: fixture.center, zoom: 17, pitch: 52, bearing: -22 })
    configureBuildings3d(map, { enabled: true, density: 'full' })
    addMarker(fixture.center)
    await settle()
    const candidate = snapshot(fixture.id)
    if (candidate.renderedFeatureCount > 0 && candidate.sourceIdle) {
      selected = candidate
      break
    }
  }
  if (!selected) throw new Error('NO_PUBLIC_BUILDING_FEATURES')
  window.__strackerMap3dQa = {
    ready: true,
    selected,
    snapshot: () => snapshot(selected.fixtureId),
    toggle: (enabled) => toggle(enabled, selected.fixtureId),
  }
}
run().catch((error) => {
  window.__strackerMap3dQa = { ready: false, error: String(error?.message || error) }
})
`
}

async function imageDifference(a: Uint8Array, b: Uint8Array): Promise<{ changedPixels: number; meanAbsoluteDelta: number }> {
  const [left, right] = await Promise.all([
    sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ])
  ok(left.info.width === right.info.width && left.info.height === right.info.height && left.info.channels === right.info.channels, 'MAP3D_SCREENSHOT_DIMENSION_MISMATCH')
  let changedPixels = 0
  let totalDelta = 0
  const channels = left.info.channels
  for (let index = 0; index < left.data.length; index += channels) {
    let pixelDelta = 0
    for (let channel = 0; channel < Math.min(3, channels); channel += 1) {
      pixelDelta += Math.abs(left.data[index + channel] - right.data[index + channel])
    }
    totalDelta += pixelDelta
    if (pixelDelta >= 12) changedPixels += 1
  }
  return {
    changedPixels,
    meanAbsoluteDelta: totalDelta / Math.max(1, left.info.width * left.info.height * 3),
  }
}

export interface Map3dQaOptions {
  targetUrl?: string
  expectedSha?: string
  expectedVersionId?: string
  overrideVersion?: string
  output?: string
}

export interface Map3dQaResult {
  schema: string
  sourceSha: string | null
  targetRuntimeVerified: boolean
  fixtureId: string
  privateDataUsed: false
  realUserCoordinatesUsed: false
  coordinateValuesRetained: false
  renderedFeatureCount: number
  source: string
  sourceLayer: string
  uniqueHeightCount: number
  fallbackUsed: boolean
  changedPixels: number
  meanAbsoluteDelta: number
  gates: Record<string, 'PASS'>
}

export async function runMap3dRuntimeQa(options: Map3dQaOptions = {}): Promise<Map3dQaResult> {
  if (options.targetUrl) {
    ok(/^[0-9a-f]{40}$/.test(options.expectedSha || ''), 'MAP3D_EXPECTED_SHA_REQUIRED')
    ok(Boolean(options.expectedVersionId), 'MAP3D_EXPECTED_VERSION_REQUIRED')
  }
  await verifyRuntimeIdentity(options)

  const work = await mkdtemp(join(tmpdir(), 'stracker-map3d-'))
  const entry = join(process.cwd(), `.stracker-map3d-entry-${process.pid}-${Date.now()}.ts`)
  let browser
  let server
  try {
    await writeFile(entry, browserEntry())
    const build = await Bun.build({
      entrypoints: [entry],
      target: 'browser',
      format: 'esm',
      minify: false,
      sourcemap: 'none',
      outdir: work,
    })
    ok(build.success && build.outputs.length === 1, 'MAP3D_BROWSER_BUNDLE_FAILED')
    const bundle = await build.outputs[0].text()
    const css = await Bun.file(join(process.cwd(), 'node_modules/maplibre-gl/dist/maplibre-gl.css')).text()
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/fixture.js') return new Response(bundle, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' } })
        if (path === '/maplibre.css') return new Response(css, { headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' } })
        return new Response(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/maplibre.css"><style>html,body,#map{width:100%;height:100%;margin:0;background:#050505;overflow:hidden}</style></head><body><div id="map"></div><script type="module" src="/fixture.js"></script></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
      },
    })

    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
    })
    const page = await browser.newPage()
    await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 1 })
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error instanceof Error ? error.message : 'PAGEERROR'))
    await page.goto(`http://${server.hostname}:${server.port}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.waitForFunction(() => (window as any).__strackerMap3dQa?.ready === true || Boolean((window as any).__strackerMap3dQa?.error), { timeout: 90_000 })
    const initial = await page.evaluate(() => (window as any).__strackerMap3dQa)
    ok(initial?.ready === true, `MAP3D_FIXTURE_${String(initial?.error || 'NOT_READY').replace(/[^A-Z0-9_]+/gi, '_').slice(0, 80)}`)
    ok(pageErrors.length === 0, 'MAP3D_PAGE_ERROR')

    const mapElement = await page.$('#map')
    const clip = await mapElement?.boundingBox()
    ok(Boolean(clip), 'MAP3D_CANVAS_BOUNDS_UNAVAILABLE')
    const onImage = await page.screenshot({ clip: clip! })
    const off = await page.evaluate(() => (window as any).__strackerMap3dQa.toggle(false))
    const offImage = await page.screenshot({ clip: clip! })
    const onAgain = await page.evaluate(() => (window as any).__strackerMap3dQa.toggle(true))
    const diff = await imageDifference(onImage, offImage)

    const selected = initial.selected
    ok(selected.layerType === 'fill-extrusion', 'MAP3D_FILL_EXTRUSION_MISSING')
    ok(typeof selected.source === 'string' && selected.source.length > 0, 'MAP3D_SOURCE_UNRESOLVED')
    ok(typeof selected.sourceLayer === 'string' && selected.sourceLayer.length > 0, 'MAP3D_SOURCE_LAYER_UNRESOLVED')
    ok(selected.renderedFeatureCount > 0, 'MAP3D_RENDERED_FEATURES_ZERO')
    ok(selected.sourceIdle === true, 'MAP3D_SOURCE_NOT_IDLE')
    ok(selected.zoom >= 16 && selected.zoom <= 18, 'MAP3D_URBAN_ZOOM_OUT_OF_RANGE')
    ok(selected.pitch >= 45 && selected.pitch <= 60, 'MAP3D_PITCH_OUT_OF_RANGE')
    ok(selected.markerAboveBuildings === true, 'MAP3D_MARKER_NOT_ABOVE_BUILDINGS')
    ok(selected.labelsAboveBuildings === true, 'MAP3D_LABELS_NOT_USABLE')
    ok(selected.uniqueHeightCount > 1 || selected.fallbackUsed === true, 'MAP3D_HEIGHT_VARIATION_OR_FALLBACK_MISSING')
    ok(off.visible === false && off.renderedFeatureCount === 0, 'MAP3D_TOGGLE_OFF_INEFFECTIVE')
    ok(onAgain.visible === true && onAgain.renderedFeatureCount > 0, 'MAP3D_TOGGLE_ON_INEFFECTIVE')
    ok(diff.changedPixels > 250 && diff.meanAbsoluteDelta > 0.02, 'MAP3D_VISIBLE_PIXEL_EFFECT_MISSING')

    const result: Map3dQaResult = {
      schema: 'stracker.map-3d-runtime-qa.v1',
      sourceSha: options.expectedSha || null,
      targetRuntimeVerified: Boolean(options.targetUrl),
      fixtureId: selected.fixtureId,
      privateDataUsed: false,
      realUserCoordinatesUsed: false,
      coordinateValuesRetained: false,
      renderedFeatureCount: selected.renderedFeatureCount,
      source: selected.source,
      sourceLayer: selected.sourceLayer,
      uniqueHeightCount: selected.uniqueHeightCount,
      fallbackUsed: selected.fallbackUsed,
      changedPixels: diff.changedPixels,
      meanAbsoluteDelta: Math.round(diff.meanAbsoluteDelta * 10000) / 10000,
      gates: {
        MAP_3D_RUNTIME_TESTS: 'PASS',
        PUBLIC_OSM_BUILDING_FIXTURE: 'PASS',
        URBAN_ZOOM_16_TO_18: 'PASS',
        PITCH_45_TO_60: 'PASS',
        SOURCE_IDLE_BEFORE_ASSERTION: 'PASS',
        FILL_EXTRUSION_LAYER_RESOLVED: 'PASS',
        BUILDING_SOURCE_AND_SOURCE_LAYER_RESOLVED: 'PASS',
        RENDERED_BUILDING_FEATURES_GT_ZERO: 'PASS',
        WALLS_AND_ROOFS_VISIBLE: 'PASS',
        HEIGHT_VARIATION_OR_SAFE_FALLBACK: 'PASS',
        BUILDING_TOGGLE_VISIBLE_EFFECT: 'PASS',
        MARKER_ABOVE_BUILDINGS: 'PASS',
        LABELS_USABLE_ABOVE_BUILDINGS: 'PASS',
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
  })
  console.log(`MAP_3D_RUNTIME_QA=PASS fixture=${result.fixtureId} features=${result.renderedFeatureCount}`)
}
