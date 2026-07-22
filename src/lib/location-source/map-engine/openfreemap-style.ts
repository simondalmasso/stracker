import type { Map as MapLibreMap } from 'maplibre-gl'

export const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'
export const OPENFREEMAP_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap'
export const MAP_PROVIDER_ID = 'openfreemap-openstreetmap'

export interface BuildingLayerOptions {
  enabled: boolean
  density: 'full' | 'reduced' | 'off'
}

function vectorSourceId(map: MapLibreMap): string | null {
  const sources = map.getStyle().sources ?? {}
  for (const [id, source] of Object.entries(sources)) {
    if (source.type === 'vector') return id
  }
  return null
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
  const layerId = 'stracker-buildings-3d'
  if (map.getLayer(layerId)) {
    map.setLayoutProperty(layerId, 'visibility', options.enabled && options.density !== 'off' ? 'visible' : 'none')
    return true
  }
  if (!options.enabled || options.density === 'off') return false
  const source = vectorSourceId(map)
  if (!source) return false
  const before = (map.getStyle().layers ?? []).find((layer) => layer.type === 'symbol')?.id
  map.addLayer({
    id: layerId,
    type: 'fill-extrusion',
    source,
    'source-layer': 'building',
    minzoom: options.density === 'reduced' ? 15.5 : 14,
    filter: ['all', ['!=', ['get', 'hide_3d'], true]],
    paint: {
      'fill-extrusion-color': [
        'interpolate', ['linear'], ['zoom'],
        14, '#16191c',
        17, '#30353a',
      ],
      'fill-extrusion-height': [
        'coalesce',
        ['to-number', ['get', 'render_height']],
        ['to-number', ['get', 'height']],
        8,
      ],
      'fill-extrusion-base': [
        'coalesce',
        ['to-number', ['get', 'render_min_height']],
        ['to-number', ['get', 'min_height']],
        0,
      ],
      'fill-extrusion-opacity': options.density === 'reduced' ? 0.46 : 0.64,
      'fill-extrusion-vertical-gradient': true,
    },
  }, before)
  return true
}
