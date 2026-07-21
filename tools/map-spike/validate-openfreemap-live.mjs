import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { VectorTile } from '@mapbox/vector-tile'
import Pbf from 'pbf'

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'
const EXPECTED_HOST = 'tiles.openfreemap.org'
const OUTPUT = process.env.OPENFREEMAP_LIVE_OUTPUT || '/tmp/openfreemap-live-results.json'
const FIXTURE = {
  id: 'SANTA_FE_PUBLIC_CIVIC_GRID_V1',
  description: 'Public generic cartographic validation area in central Santa Fe, Argentina',
  lng: -60.7103,
  lat: -31.6575,
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function tileCoordinate(lng, lat, zoom) {
  const scale = 2 ** zoom
  const x = Math.floor(((lng + 180) / 360) * scale)
  const radians = (lat * Math.PI) / 180
  const y = Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * scale)
  return { x, y, z: zoom }
}

function expandTemplate(template, tile) {
  return template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y))
    .replace('{-y}', String((2 ** tile.z) - tile.y - 1))
}

function safeUrl(raw, base = STYLE_URL) {
  const url = new URL(raw, base)
  assert(url.protocol === 'https:', `non-HTTPS provider URL: ${url.protocol}`)
  assert(url.hostname === EXPECTED_HOST, `unexpected provider host: ${url.hostname}`)
  for (const key of url.searchParams.keys()) {
    assert(!/token|key|access/i.test(key), `credential-like query parameter found: ${key}`)
  }
  return url
}

function safeTemplate(raw, base = STYLE_URL) {
  return safeUrl(raw, base).toString()
    .replace(/%7B/gi, '{')
    .replace(/%7D/gi, '}')
}

async function fetchChecked(url, expectedType) {
  const response = await fetch(url, {
    redirect: 'error',
    headers: {
      Accept: expectedType,
      'User-Agent': 'STRACKER-NonPrivate-Map-Validation/1.0',
    },
  })
  assert(response.ok, `provider request failed: ${response.status} ${new URL(url).pathname}`)
  assert(response.url && new URL(response.url).hostname === EXPECTED_HOST, 'provider redirected to an unexpected host')
  return response
}

function layerFeatureCount(tile, predicate) {
  let count = 0
  for (const [name, layer] of Object.entries(tile.layers)) {
    if (!predicate(name)) continue
    count += layer.length
  }
  return count
}

function inspectBuildings(tile) {
  let footprints = 0
  let withHeight = 0
  const heightKeys = new Set()
  for (const [name, layer] of Object.entries(tile.layers)) {
    if (!/building/i.test(name)) continue
    for (let index = 0; index < layer.length; index += 1) {
      const feature = layer.feature(index)
      const properties = feature.properties || {}
      footprints += 1
      for (const key of ['render_height', 'height', 'building:levels', 'levels']) {
        const value = properties[key]
        if (value !== undefined && value !== null && value !== '') {
          withHeight += 1
          heightKeys.add(key)
          break
        }
      }
    }
  }
  return { footprints, withHeight, heightKeys: [...heightKeys].sort() }
}

const styleResponse = await fetchChecked(STYLE_URL, 'application/json')
const styleText = await styleResponse.text()
const style = JSON.parse(styleText)
assert(style.version === 8, 'unexpected style specification version')
assert(Array.isArray(style.layers) && style.layers.length > 0, 'style has no layers')

const hosts = new Set([new URL(STYLE_URL).hostname])
for (const value of [style.sprite, style.glyphs].filter(Boolean)) {
  const url = safeUrl(value)
  hosts.add(url.hostname)
}

const vectorSourceEntry = Object.entries(style.sources || {}).find(([, source]) => source?.type === 'vector')
assert(vectorSourceEntry, 'style contains no vector source')
const [vectorSourceName, vectorSource] = vectorSourceEntry
let tileTemplates = Array.isArray(vectorSource.tiles) ? vectorSource.tiles : null
let tileJson = null
let tileJsonResponse = null
if (!tileTemplates && vectorSource.url) {
  const tileJsonUrl = safeUrl(vectorSource.url)
  hosts.add(tileJsonUrl.hostname)
  tileJsonResponse = await fetchChecked(tileJsonUrl, 'application/json')
  tileJson = await tileJsonResponse.json()
  tileTemplates = tileJson.tiles
}
assert(Array.isArray(tileTemplates) && tileTemplates.length > 0, 'vector source contains no tile templates')
const template = safeTemplate(tileTemplates[0], vectorSource.url || STYLE_URL)
hosts.add(new URL(expandTemplate(template, { z: 0, x: 0, y: 0 })).hostname)

const advertisedMaxZoom = Number(tileJson?.maxzoom ?? vectorSource.maxzoom ?? 14)
const highestTestZoom = Math.min(14, Number.isFinite(advertisedMaxZoom) ? advertisedMaxZoom : 14)
const zoomLevels = [...new Set([highestTestZoom, highestTestZoom - 1, highestTestZoom - 2].filter((zoom) => zoom >= 0))]

let streetFeatures = 0
let buildingFootprints = 0
let buildingsWithHeight = 0
const heightKeys = new Set()
let totalTileBytes = 0
let requestedTiles = 0
let nonEmptyTiles = 0
let emptyTiles = 0
let selectedZoom = null
const tileHashes = []

for (const zoom of zoomLevels) {
  const center = tileCoordinate(FIXTURE.lng, FIXTURE.lat, zoom)
  let zoomStreet = 0
  let zoomBuildings = 0
  let zoomHeights = 0
  const zoomHeightKeys = new Set()
  const zoomHashes = []
  let zoomBytes = 0
  let zoomRequested = 0
  let zoomNonEmpty = 0
  let zoomEmpty = 0

  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const tile = { z: zoom, x: center.x + dx, y: center.y + dy }
      const tileUrl = safeUrl(expandTemplate(template, tile))
      const response = await fetchChecked(tileUrl, 'application/x-protobuf,application/vnd.mapbox-vector-tile,application/octet-stream')
      const buffer = Buffer.from(await response.arrayBuffer())
      zoomRequested += 1
      if (buffer.byteLength === 0) {
        zoomEmpty += 1
        continue
      }
      const decoded = new VectorTile(new Pbf(buffer))
      zoomStreet += layerFeatureCount(decoded, (name) => /transportation|road|street/i.test(name))
      const buildings = inspectBuildings(decoded)
      zoomBuildings += buildings.footprints
      zoomHeights += buildings.withHeight
      buildings.heightKeys.forEach((key) => zoomHeightKeys.add(key))
      zoomBytes += buffer.byteLength
      zoomNonEmpty += 1
      zoomHashes.push(sha256(buffer))
    }
  }

  if (zoomStreet > 0 && zoomBuildings > 0 && zoomNonEmpty > 0) {
    selectedZoom = zoom
    streetFeatures = zoomStreet
    buildingFootprints = zoomBuildings
    buildingsWithHeight = zoomHeights
    zoomHeightKeys.forEach((key) => heightKeys.add(key))
    totalTileBytes = zoomBytes
    requestedTiles = zoomRequested
    nonEmptyTiles = zoomNonEmpty
    emptyTiles = zoomEmpty
    tileHashes.push(...zoomHashes)
    break
  }
}

assert(selectedZoom !== null, 'no public Santa Fe street/building coverage found in tested tiles')
assert(nonEmptyTiles > 0, 'all requested vector tiles were empty')
assert(streetFeatures > 0, 'street coverage validation failed')
assert(buildingFootprints > 0, 'building footprint validation failed')
assert(buildingsWithHeight > 0, 'no available building-height metadata found in tested public fixture')

const attribution = String(tileJson?.attribution || vectorSource.attribution || '')
const attributionPresent = /openstreetmap|openmaptiles/i.test(attribution) || style.layers.some((layer) => /openstreetmap|openmaptiles/i.test(JSON.stringify(layer.metadata || {})))
assert(attributionPresent || styleText.includes('OpenStreetMap'), 'provider attribution metadata not found')

const result = {
  schema: 'stracker.openfreemap-live-validation.v1',
  generatedAt: new Date().toISOString(),
  fixture: {
    id: FIXTURE.id,
    classification: 'PUBLIC_GENERIC_NON_PRIVATE',
    coordinateValuesRetained: false,
  },
  style: {
    host: new URL(STYLE_URL).hostname,
    path: new URL(STYLE_URL).pathname,
    status: styleResponse.status,
    contentType: styleResponse.headers.get('content-type'),
    sha256: sha256(styleText),
    layerCount: style.layers.length,
    vectorSourceName,
    tokenQueryParameters: false,
    applicationCookiesSent: false,
    setCookieObserved: Boolean(styleResponse.headers.get('set-cookie')),
  },
  tileJson: tileJsonResponse ? {
    status: tileJsonResponse.status,
    contentType: tileJsonResponse.headers.get('content-type'),
    advertisedMaxZoom,
  } : null,
  vectorTiles: {
    selectedZoom,
    requestedTiles,
    nonEmptyTiles,
    emptyTiles,
    totalBytes: totalTileBytes,
    tileSha256: tileHashes,
    streetFeatures,
    buildingFootprints,
    buildingsWithHeight,
    heightKeys: [...heightKeys].sort(),
    completeCoverageClaimed: false,
    completeHeightCoverageClaimed: false,
  },
  hosts: [...hosts].sort(),
  attributionMetadataPresent: true,
  gates: {
    STYLE_ACCESSIBLE: 'PASS',
    TILES_ACCESSIBLE: 'PASS',
    EMPTY_TILES_HANDLED: 'PASS',
    SANTA_FE_STREETS_PRESENT: 'PASS',
    BUILDING_FOOTPRINTS_PRESENT: 'PASS',
    BUILDING_HEIGHTS_AVAILABLE_WHERE_PRESENT: 'PASS',
    EXACT_HOST: 'PASS',
    TOKEN_ABSENT: 'PASS',
    APPLICATION_COOKIES_ABSENT: 'PASS',
    COMPLETE_COVERAGE_NOT_CLAIMED: 'PASS',
  },
}

await writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
console.log('OPENFREEMAP_LIVE_VALIDATION=PASS')
console.log(`OPENFREEMAP_LIVE_RESULTS=${OUTPUT}`)
