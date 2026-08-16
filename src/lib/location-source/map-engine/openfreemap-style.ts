import type { Map as MapLibreMap } from 'maplibre-gl'
import { SANTA_FE_3D_LAYER_IDS } from './santa-fe-city-config'

export const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'
export const OPENFREEMAP_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap'
export const MAP_PROVIDER_ID = 'openfreemap-openstreetmap'
export const STRACKER_GENERIC_BUILDING_LAYER_ID = 'stracker-buildings-3d'

export interface BuildingLayerOptions {
  enabled: boolean
  density: 'full' | 'reduced' | 'off'
}

interface BuildingSourceCandidate {
  source: string
  sourceLayer: string
}

const CONTROLLED_BUILDING_LAYER_IDS = new Set<string>([STRACKER_GENERIC_BUILDING_LAYER_ID, ...SANTA_FE_3D_LAYER_IDS])

function vectorSourceId(map: MapLibreMap): string | null {
  const sources = map.getStyle().sources ?? {}
  for (const [id, source] of Object.entries(sources)) {
    if (source.type === 'vector') return id
  }
  return null
}

function buildingSourceCandidate(map: MapLibreMap): BuildingSourceCandidate | null {
  for (const layer of map.getStyle().layers ?? []) {
    if (CONTROLLED_BUILDING_LAYER_IDS.has(layer.id)) continue
    const candidate = layer as typeof layer & { source?: string; 'source-layer'?: string }
    const source = candidate.source
    const sourceLayer = candidate['source-layer']
    if (typeof source !== 'string' || typeof sourceLayer !== 'string') continue
    const identity = `${candidate.id} ${sourceLayer}`.toLowerCase()
    if (sourceLayer.toLowerCase() === 'building' || identity.includes('building')) {
      return { source, sourceLayer }
    }
  }

  const source = vectorSourceId(map)
  return source ? { source, sourceLayer: 'building' } : null
}

function styleLayerVisibility(layer: { layout?: unknown } | undefined): 'visible' | 'none' {
  if (!layer?.layout || typeof layer.layout !== 'object') return 'visible'
  return 'visibility' in layer.layout && layer.layout.visibility === 'none' ? 'none' : 'visible'
}

function hideUncontrolledBuildingExtrusions(map: MapLibreMap): void {
  for (const layer of map.getStyle().layers ?? []) {
    if (CONTROLLED_BUILDING_LAYER_IDS.has(layer.id) || layer.type !== 'fill-extrusion') continue
    const candidate = layer as typeof layer & { 'source-layer'?: string }
    const sourceLayer = candidate['source-layer']?.toLowerCase() ?? ''
    const identity = `${layer.id} ${sourceLayer}`.toLowerCase()
    if ((sourceLayer === 'building' || identity.includes('building')) && styleLayerVisibility(layer) !== 'none') {
      map.setLayoutProperty(layer.id, 'visibility', 'none')
    }
  }
}

export function configureSceneLight(map: MapLibreMap): void {
  const mapWithLight = map as MapLibreMap & {
    setLight?: (light: {
      anchor: 'map'
      color: string
      intensity: number
      position: [number, number, number]
    }) => void
  }
  mapWithLight.setLight?.({
    anchor: 'map',
    color: '#fffdf5',
    intensity: 0.78,
    position: [1.2, 215, 42],
  })
}

function hasTextField(layer: { layout?: unknown }): boolean {
  return Boolean(layer.layout && typeof layer.layout === 'object' && 'text-field' in layer.layout)
}

export function setDarkBaseStyle(map: MapLibreMap): void {
  setLightCityBaseStyle(map)
}

export function setLightCityBaseStyle(map: MapLibreMap): void {
  for (const layer of map.getStyle().layers ?? []) {
    const id = layer.id.toLowerCase()
    if (layer.type === 'background') {
      map.setPaintProperty(layer.id, 'background-color', '#f2f1ed')
      continue
    }
    if (layer.type === 'fill') {
      if (id.includes('water')) map.setPaintProperty(layer.id, 'fill-color', '#dce8eb')
      else if (id.includes('park') || id.includes('green') || id.includes('wood')) map.setPaintProperty(layer.id, 'fill-color', '#e5ebe3')
      else if (id.includes('land') || id.includes('background')) map.setPaintProperty(layer.id, 'fill-color', '#efefeb')
      else if (id.includes('building')) map.setPaintProperty(layer.id, 'fill-color', '#e2e3df')
      continue
    }
    if (layer.type === 'line') {
      if (id.includes('road') || id.includes('street') || id.includes('transport')) {
        map.setPaintProperty(layer.id, 'line-color', id.includes('outline') || id.includes('casing') ? '#c9cdcf' : '#ffffff')
      } else if (id.includes('boundary')) {
        map.setPaintProperty(layer.id, 'line-color', '#c6c9ca')
      }
      continue
    }
    if (layer.type === 'symbol' && hasTextField(layer)) {
      map.setPaintProperty(layer.id, 'text-color', '#4b535a')
      map.setPaintProperty(layer.id, 'text-halo-color', '#fbfaf7')
      map.setPaintProperty(layer.id, 'text-halo-width', 1.25)
    }
  }
  configureSceneLight(map)
}

export function configureBuildings3d(map: MapLibreMap, options: BuildingLayerOptions): boolean {
  hideUncontrolledBuildingExtrusions(map)

  const existingGenericLayer = (map.getStyle().layers ?? []).find((layer) => layer.id === STRACKER_GENERIC_BUILDING_LAYER_ID)
  if (existingGenericLayer) {
    const desiredVisibility = options.enabled && options.density !== 'off' ? 'visible' : 'none'
    const currentVisibility = styleLayerVisibility(existingGenericLayer)
    if (currentVisibility !== desiredVisibility) {
      map.setLayoutProperty(STRACKER_GENERIC_BUILDING_LAYER_ID, 'visibility', desiredVisibility)
      if (desiredVisibility === 'visible') configureSceneLight(map)
    }
    return true
  }
  if (!options.enabled || options.density === 'off') return false

  const candidate = buildingSourceCandidate(map)
  if (!candidate) return false

  const before = (map.getStyle().layers ?? []).find((layer) => layer.type === 'symbol')?.id
  map.addLayer({
    id: STRACKER_GENERIC_BUILDING_LAYER_ID,
    type: 'fill-extrusion',
    source: candidate.source,
    'source-layer': candidate.sourceLayer,
    minzoom: options.density === 'reduced' ? 15 : 13.5,
    paint: {
      'fill-extrusion-color': [
        'interpolate',
        ['linear'],
        [
          'max',
          3,
          [
            'case',
            ['has', 'render_height'], ['to-number', ['get', 'render_height'], 12],
            ['has', 'height'], ['to-number', ['get', 'height'], 12],
            ['has', 'building:levels'], ['*', ['to-number', ['get', 'building:levels'], 4], 3],
            ['has', 'levels'], ['*', ['to-number', ['get', 'levels'], 4], 3],
            12,
          ],
        ],
        0, '#e3e4e0',
        30, '#cbd0d2',
        80, '#adb5bd',
        180, '#929da7',
      ],
      'fill-extrusion-height': [
        'max',
        3,
        [
          'case',
          ['has', 'render_height'], ['to-number', ['get', 'render_height'], 12],
          ['has', 'height'], ['to-number', ['get', 'height'], 12],
          ['has', 'building:levels'], ['*', ['to-number', ['get', 'building:levels'], 4], 3],
          ['has', 'levels'], ['*', ['to-number', ['get', 'levels'], 4], 3],
          12,
        ],
      ],
      'fill-extrusion-base': [
        'case',
        ['has', 'render_min_height'], ['to-number', ['get', 'render_min_height'], 0],
        ['has', 'min_height'], ['to-number', ['get', 'min_height'], 0],
        0,
      ],
      'fill-extrusion-opacity': options.density === 'reduced' ? 0.78 : 0.92,
      'fill-extrusion-vertical-gradient': true,
    }, before)
  configureSceneLight(map)
  return true
}
