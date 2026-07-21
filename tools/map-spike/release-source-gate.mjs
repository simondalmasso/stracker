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
  { name: 'Legacy ArcGIS endpoint', pattern: /server\.arcgisonline\.com/i },
  { name: 'Persisted source selection', pattern: /stracker\.lastSelectedSource/ },
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
for (const file of files) {
  const text = await readFile(file, 'utf8')
  if (text.includes('https://tiles.openfreemap.org/styles/liberty')) selectedStyleFound = true
  for (const rule of forbidden) {
    if (rule.pattern.test(text)) {
      throw new Error(`${rule.name} found in ${file}`)
    }
  }
}

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const dependencies = { ...pkg.dependencies, ...pkg.devDependencies }
for (const name of ['mapbox-gl', 'leaflet', 'react-leaflet', '@types/leaflet']) {
  if (name in dependencies) throw new Error(`unselected engine dependency remains in package.json: ${name}`)
}
if (!('maplibre-gl' in dependencies)) throw new Error('selected MapLibre dependency is absent')
if (!selectedStyleFound) throw new Error('selected OpenFreeMap style URL is absent from release source')

console.log(`RELEASE_SOURCE_FILES_SCANNED=${files.length}`)
console.log('RELEASE_SOURCE_GATE=PASS')
