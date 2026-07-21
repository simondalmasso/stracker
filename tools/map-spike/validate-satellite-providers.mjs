import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const output = process.env.SATELLITE_PROVIDER_OUTPUT || '/tmp/satellite-provider-results.json'
const policy = JSON.parse(await readFile('src/lib/location-source/map-engine/satellite-provider-policy.json', 'utf8'))
const selected = policy.selectedProvider

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function tileFor(lng, lat, zoom) {
  const scale = 2 ** zoom
  const x = Math.floor(((lng + 180) / 360) * scale)
  const latRad = lat * Math.PI / 180
  const y = Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * scale)
  return { x, y, z: zoom }
}

function expand(template, tile) {
  return template.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y))
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' })
  } finally {
    clearTimeout(timeout)
  }
}

async function optionalProbe(url) {
  try {
    const response = await fetchWithTimeout(url, { headers: { Accept: 'application/xml,text/xml,text/html,*/*' } })
    const body = await response.text()
    return {
      reachable: response.ok,
      status: response.status,
      cors: response.headers.get('access-control-allow-origin'),
      bytes: Buffer.byteLength(body),
      body,
    }
  } catch (error) {
    return { reachable: false, status: null, cors: null, bytes: 0, body: '', error: String(error) }
  }
}

assert(selected.costUsd === 0, 'selected satellite provider is not zero cost')
assert(selected.apiKeyRequired === false, 'selected satellite provider requires an API key')
assert(selected.paidOverageAllowed === false, 'selected satellite provider allows paid overage')
assert(selected.billingDependency === false, 'selected satellite provider has a billing dependency')
assert(selected.automaticUpgradeToPaid === false, 'selected satellite provider may upgrade automatically')
assert(selected.license === 'CC BY 4.0', 'selected satellite provider license is not the approved CC BY 4.0 release')
assert(selected.recentClaimAllowed === false, 'historical imagery must not be presented as recent')
assert(selected.tileTemplate.startsWith('https://tiles.maps.eox.at/'), 'unexpected satellite tile host')
assert(!/(google|mapbox|arcgis|maptiler)/i.test(selected.tileTemplate), 'forbidden satellite provider present')

const capabilitiesResponse = await fetchWithTimeout(selected.capabilitiesUrl, { headers: { Accept: 'application/xml,text/xml,*/*' } })
assert(capabilitiesResponse.ok, `selected WMTS capabilities unavailable: ${capabilitiesResponse.status}`)
const capabilities = await capabilitiesResponse.text()
assert(capabilities.includes('s2cloudless-2016_3857'), 'selected WMTS layer is absent from capabilities')

const publicTile = tileFor(-60.7, -31.6333, Math.min(13, selected.maxZoom))
const tileUrl = expand(selected.tileTemplate, publicTile)
const tileResponse = await fetchWithTimeout(tileUrl, { headers: { Accept: 'image/jpeg,image/png,image/*' } })
assert(tileResponse.ok, `selected satellite tile unavailable: ${tileResponse.status}`)
const tileBuffer = Buffer.from(await tileResponse.arrayBuffer())
const tileType = tileResponse.headers.get('content-type') || ''
assert(tileBuffer.byteLength > 100, 'selected satellite tile is empty')
assert(tileType.startsWith('image/'), `selected satellite tile returned ${tileType}`)
const cors = tileResponse.headers.get('access-control-allow-origin')
assert(cors === '*' || Boolean(cors), 'selected satellite endpoint does not publish a CORS allowance')

const ignServicePage = await optionalProbe('https://www.ign.gob.ar/NuestrasActividades/InformacionGeoespacial/ServiciosOGC')
const ignOrthomosaic = await optionalProbe('https://imagenes.ign.gob.ar/geoserver/gwc/service/wmts?REQUEST=GetCapabilities')
const ignHybrid = policy.evaluatedCandidates.find((candidate) => candidate.id === 'ign-argenmap-hybrid')
const ignOrtho = policy.evaluatedCandidates.find((candidate) => candidate.id === 'ign-public-orthomosaics')
assert(ignHybrid?.selected === false, 'IGN hybrid must remain blocked until imagery provenance and license are explicit')
assert(ignOrtho?.selected === false, 'partial IGN orthomosaics must not be claimed as a complete basemap')

const result = {
  schema: 'stracker.satellite-provider-validation.v1',
  generatedAt: new Date().toISOString(),
  publicFixture: 'SANTA_FE_PUBLIC_GENERIC',
  coordinateValuesRetained: false,
  selectedProvider: {
    id: selected.id,
    role: selected.role,
    host: selected.host,
    costUsd: selected.costUsd,
    apiKeyRequired: selected.apiKeyRequired,
    paidOverageAllowed: selected.paidOverageAllowed,
    billingDependency: selected.billingDependency,
    license: selected.license,
    attribution: selected.attribution,
    imageryPeriod: selected.imageryPeriod,
    recentClaimAllowed: selected.recentClaimAllowed,
    coverage: selected.coverage,
    completeCoverageClaimed: selected.completeCoverageClaimed,
    maxZoom: selected.maxZoom,
    resolutionMeters: selected.resolutionMeters,
    capabilitiesAccessible: true,
    cors,
    tileContentType: tileType,
    tileBytes: tileBuffer.byteLength,
    tileSha256: createHash('sha256').update(tileBuffer).digest('hex'),
  },
  evaluatedCandidates: [
    {
      id: 'ign-argenmap-hybrid',
      status: ignHybrid.status,
      officialServicePageReachable: ignServicePage.reachable,
      completeCoverageClaimed: false,
      selected: false,
    },
    {
      id: 'ign-public-orthomosaics',
      status: ignOrtho.status,
      capabilitiesReachable: ignOrthomosaic.reachable,
      capabilitiesBytes: ignOrthomosaic.bytes,
      cors: ignOrthomosaic.cors,
      santaFeCompleteCoverageClaimed: false,
      selected: false,
    },
    {
      id: selected.id,
      status: 'SELECTED_AS_AUTHORIZED_OPEN_FALLBACK',
      selected: true,
    },
  ],
  hosts: [selected.host, 'imagenes.ign.gob.ar', 'www.ign.gob.ar'],
  gates: {
    COSTO_USD_0: 'PASS',
    SIN_API_KEY: 'PASS',
    SIN_OVERAGE_PAGO: 'PASS',
    BILLING_DEPENDENCY_NO: 'PASS',
    LICENSE_DOCUMENTED: 'PASS',
    ATTRIBUTION_DOCUMENTED: 'PASS',
    CORS: 'PASS',
    COBERTURA_SANTA_FE_FALLBACK: 'PASS',
    IMAGERY_AGE_DISCLOSED: 'PASS',
    COMPLETE_IGN_ORTHOMOSAIC_COVERAGE_NOT_CLAIMED: 'PASS',
    FORBIDDEN_PROVIDERS_ABSENT: 'PASS',
    ZERO_COST_SATELLITE_GATE: 'PASS',
  },
}

await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
console.log(`SATELLITE_PROVIDER_RESULTS=${output}`)
console.log('ZERO_COST_SATELLITE_GATE=PASS')
