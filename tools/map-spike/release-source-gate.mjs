import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

const roots = [
  'src/app',
  'src/components/mobile',
  'src/lib/location-source',
]
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.json'])
const forbidden = [
  { name: 'Mapbox runtime import', pattern: /from\s+['"]mapbox-gl['"]|require\(['"]mapbox-gl['"]\)/ },
  { name: 'Mapbox runtime global', pattern: /\bmapboxgl\b/ },
  { name: 'Mapbox hosted API', pattern: /api\.mapbox\.com/i },
  { name: 'Mapbox public token', pattern: /\bpk\.[A-Za-z0-9._-]+/ },
  { name: 'Leaflet runtime import', pattern: /from\s+['"](?:leaflet|react-leaflet)['"]|require\(['"](?:leaflet|react-leaflet)['"]\)/ },
  { name: 'Legacy raster OSM endpoint', pattern: /tile\.openstreetmap\.org/i },
  { name: 'Google satellite endpoint', pattern: /(?:googleapis\.com|google\.com).*?(?:satellite|lyrs=s)|mt\d+\.google\.com/i },
  { name: 'Mapbox satellite endpoint', pattern: /mapbox\.com.*(?:satellite|tiles)/i },
  { name: 'ArcGIS imagery endpoint', pattern: /(?:arcgisonline\.com|arcgis\.com).*?(?:World_Imagery|imagery)/i },
  { name: 'MapTiler satellite endpoint', pattern: /maptiler\.com.*satellite/i },
  { name: 'Persisted source selection', pattern: /stracker\.lastSelectedSource/ },
  { name: 'Persisted basemap selection', pattern: /localStorage\.(?:setItem|getItem)\([^\n]*basemap|document\.cookie[^\n]*basemap|[?&]basemap=/i },
  { name: 'Removed dead freshness state', pattern: /['"]dead['"]/ },
]

async function filesUnder(root) {
  const result = []
  async function walk(current) {
    const entries = await readdir(current)
    for (const entry of entries) {
      const path = join(current, entry)
      const info = await stat(path)
      if (info.isDirectory()) await walk(path)
      else if (sourceExtensions.has(extname(path))) result.push(path)
    }
  }
  await walk(root)
  return result
}

const files = (await Promise.all(roots.map(filesUnder))).flat().sort()
let selectedStyleFound = false
let selectedSatelliteFound = false
let basemapTypeFound = false
for (const file of files) {
  const text = await readFile(file, 'utf8')
  if (text.includes('https://tiles.openfreemap.org/styles/liberty')) selectedStyleFound = true
  if (text.includes('https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg')) selectedSatelliteFound = true
  if (/BasemapMode\s*=\s*['"]vector-3d['"]\s*\|\s*['"]satellite['"]\s*\|\s*['"]hybrid['"]/.test(text)) basemapTypeFound = true
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) throw new Error(`${rule.name} found in ${file}`)
  }
}

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const dependencies = { ...pkg.dependencies, ...pkg.devDependencies }
for (const name of ['mapbox-gl', 'leaflet', 'react-leaflet', '@types/leaflet']) {
  if (name in dependencies) throw new Error(`unselected engine dependency remains in package.json: ${name}`)
}
if (!('maplibre-gl' in dependencies)) throw new Error('selected MapLibre dependency is absent')
if (!selectedStyleFound) throw new Error('selected OpenFreeMap style URL is absent from release source')
if (!selectedSatelliteFound) throw new Error('selected zero-cost satellite tile template is absent from release source')
if (!basemapTypeFound) throw new Error('exact BasemapMode contract is absent')

const policy = JSON.parse(await readFile('src/lib/location-source/map-engine/satellite-provider-policy.json', 'utf8'))
const selected = policy.selectedProvider
if (selected.id !== 'eox-s2cloudless-2016') throw new Error('unexpected selected satellite provider')
if (selected.wmtsLayerIdentifier !== 's2cloudless_3857') throw new Error('unexpected EOx WMTS layer identifier')
if (selected.costUsd !== 0) throw new Error('satellite provider cost is not zero')
if (selected.apiKeyRequired !== false) throw new Error('satellite provider requires an API key')
if (selected.paidOverageAllowed !== false) throw new Error('satellite provider allows paid overage')
if (selected.billingDependency !== false) throw new Error('satellite provider has a billing dependency')
if (selected.automaticUpgradeToPaid !== false) throw new Error('satellite provider can upgrade to paid')
if (selected.license !== 'CC BY 4.0') throw new Error('satellite provider license differs from approved policy')
if (selected.recentClaimAllowed !== false) throw new Error('historical imagery may be presented as recent')
if (selected.completeCoverageClaimed !== false) throw new Error('complete satellite coverage is over-claimed')
if (!selected.attribution.includes('EOxCloudless') || !selected.attribution.includes('Copernicus Sentinel data 2016 & 2017')) {
  throw new Error('required satellite attribution is incomplete')
}
for (const candidate of policy.evaluatedCandidates) {
  if (candidate.id.startsWith('ign-') && candidate.completeCoverageClaimed !== false) {
    throw new Error(`IGN candidate over-claims complete coverage: ${candidate.id}`)
  }
}

console.log(`RELEASE_SOURCE_FILES_SCANNED=${files.length}`)
console.log('DEFAULT_BASEMAP_MODE=vector-3d')
console.log('RENDERER=MapLibre GL JS')
console.log('MAP_PROVIDER_COST_USD=0')
console.log('PAID_OVERAGE_ALLOWED=NO')
console.log('BILLING_DEPENDENCY=NO')
console.log('ZERO_COST_SATELLITE_GATE=PASS')
console.log('RELEASE_SOURCE_GATE=PASS')
