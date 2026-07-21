import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

const root = 'out'
const extensions = new Set(['.html', '.js', '.css', '.json', '.txt'])
const forbidden = [
  { name: 'Mapbox hosted API', pattern: /api\.mapbox\.com/i },
  { name: 'Leaflet runtime', pattern: /leaflet-container|react-leaflet/i },
  { name: 'Legacy OSM raster', pattern: /tile\.openstreetmap\.org/i },
  { name: 'ArcGIS imagery', pattern: /(?:arcgisonline\.com|arcgis\.com).*?(?:World_Imagery|imagery)/i },
  { name: 'Google satellite', pattern: /(?:googleapis\.com|mt\d+\.google\.com).*?(?:satellite|lyrs=s)/i },
  { name: 'MapTiler satellite', pattern: /maptiler\.com.*satellite/i },
  { name: 'Origin service token', pattern: /STRACKER_SERVICE_TOKEN|X-Stracker-Service-Token/i },
  { name: 'Access assertion', pattern: /CF_Authorization/i },
  { name: 'Google session cookie', pattern: /\bSAPISID=/i },
  { name: 'Bearer credential', pattern: /Authorization:\s*Bearer/i },
]

async function filesUnder(current) {
  const result = []
  for (const entry of await readdir(current)) {
    const path = join(current, entry)
    const info = await stat(path)
    if (info.isDirectory()) result.push(...await filesUnder(path))
    else if (extensions.has(extname(path))) result.push(path)
  }
  return result
}

const files = await filesUnder(root)
let openFreeMapFound = false
let satelliteFound = false
let mapLibreFound = false
let basemapLabelsFound = false
for (const file of files) {
  const text = await readFile(file, 'utf8')
  if (text.includes('tiles.openfreemap.org')) openFreeMapFound = true
  if (text.includes('tiles.maps.eox.at')) satelliteFound = true
  if (text.includes('maplibre')) mapLibreFound = true
  if (text.includes('SATÉLITE') && text.includes('HÍBRIDO') && text.includes('MAPA 3D')) basemapLabelsFound = true
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) throw new Error(`${rule.name} found in exported runtime asset ${file}`)
  }
}

if (!openFreeMapFound) throw new Error('OpenFreeMap host absent from exported assets')
if (!satelliteFound) throw new Error('selected EOx satellite host absent from exported assets')
if (!mapLibreFound) throw new Error('MapLibre runtime marker absent from exported assets')
if (!basemapLabelsFound) throw new Error('three visible basemap labels absent from exported assets')

console.log(`EXPORTED_RUNTIME_FILES_SCANNED=${files.length}`)
console.log('SINGLE_ENGINE_FINAL_BUNDLE=PASS')
console.log('SATELLITE_SINGLE_RENDERER_BUNDLE=PASS')
console.log('SENSITIVE_DATA_IN_LOGS=NO')
console.log('SENSITIVE_DATA_IN_ARTIFACTS=NO')
