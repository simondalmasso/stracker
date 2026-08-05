import type { Map as MapLibreMap } from 'maplibre-gl'

export const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'
export const OPENFREEMAP_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap'
export const MAP_PROVIDER_ID = 'openfreemap-openstreetmap'

const STRACKER_BUILDING_LAYER_ID = 'stracker-buildings-3d'

export interface BuildingLayerOptions {
  enabled: boolean
  density: 'full' | 'reduced' | 'off'
}

interface BuildingSourceCandidate {
  source: string
  sourceLayer: string
}

function vectorSourceId(map: MapLibreMap): string | null {
  const sources = map.getStyle().sources ?? {}
  for (const [id, source] of Object.entries(sources)) {
    if (source.type === 'vector') return id
  }
  return null
}

function buildingSourceCandidate(map: MapLibreMap): BuildingSourceCandidate | null {
  for (const layer of map.getStyle().layers ?? []) {
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

function hideUncontrolledBuildingExtrusions(map: MapLibreMap): void {
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.id === STRACKER_BUILDING_LAYER_ID || layer.type !== 'fill-extrusion') continue
    const candidate = layer as typeof layer & { 'source-layer'?: string }
    const sourceLayer = candidate['source-layer']?.toLowerCase() ?? ''
    const identity = `${layer.id} ${sourceLayer}`.toLowerCase()
    if (sourceLayer === 'building' || identity.includes('building')) {
      map.setLayoutProperty(layer.id, 'visibility', 'none')
    }
  }
}

function configureSceneLight(map: MapLibreMap): void {
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
    color: '#f4f7fa',
    intensity: 0.62,
    position: [1.25, 205, 42],
  })
}

export function setDarkBaseStyle(map: MapLibreMap): void {
  const style = map.getStyle()
  for (const layer of style.layers ?? []) {
    if (layer.type === 'background') {
      map.setPaintProperty(layer.id, 'background-color', '#050505')
      continue
    }
    if (layer.type === 'fill') {
      const id = layer.id.toLowerCase()
      if (id.includes('water')) map.setPaintProperty(layer.id, 'fill-color', '#0b1117')
      else if (id.includes('land') || id.includes('park')) map.setPaintProperty(layer.id, 'fill-color', '#101214')
    }
    if (layer.type === 'line') {
      const id = layer.id.toLowerCase()
      if (id.includes('road') || id.includes('street')) map.setPaintProperty(layer.id, 'line-color', '#3c4146')
    }
  }
}

export function configureBuildings3d(map: MapLibreMap, options: BuildingLayerOptions): boolean {
  hideUncontrolledBuildingExtrusions(map)

  if (map.getLayer(STRACKER_BUILDING_LAYER_ID)) {
    map.setLayoutProperty(STRACKER_BUILDING_LAYER_ID, 'visibility', options.enabled && options.density !== 'off' ? 'visible' : 'none')
    if (options.enabled && options.density !== 'off') configureSceneLight(map)
    return true
  }
  if (!options.enabled || options.density === 'off') return false

  const candidate = buildingSourceCandidate(map)
  if (!candidate) return false

  const before = (map.getStyle().layers ?? []).find((layer) => layer.type === 'symbol')?.id
  map.addLayer({
    id: STRACKER_BUILDING_LAYER_ID,
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
        0, '#272c31',
        30, '#444b52',
        80, '#68727c',
        180, '#8d98a3',
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
      'fill-extrusion-opacity': options.density === 'reduced' ? 0.72 : 0.9,
      'fill-extrusion-vertical-gradient': true,
    },
  }, before)
  configureSceneLight(map)
  return true
}
