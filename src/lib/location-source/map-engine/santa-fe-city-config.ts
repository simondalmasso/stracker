import type { FillExtrusionLayerSpecification, VectorSourceSpecification } from 'maplibre-gl'
import {
  SANTA_FE_3D_ASSET_PATHS,
  SANTA_FE_3D_BOUNDS,
  SANTA_FE_3D_FEATURE_COUNT,
  SANTA_FE_3D_SOURCE_LAYER,
} from './santa-fe-3d-generated'

export const SANTA_FE_3D_ATTRIBUTION = '© OpenStreetMap contributors; © Overture Maps Foundation'
export const SANTA_FE_3D_SOURCE_PREFIX = 'stracker-santa-fe-3d-source'
export const SANTA_FE_3D_LAYER_PREFIX = 'stracker-santa-fe-3d-buildings'
export const SANTA_FE_3D_PUBLIC_HEALTH_MIN_RENDERED_FEATURES = 80
export const SANTA_FE_3D_PUBLIC_FIXTURES = [
  { id: 'dense-central', lng: -60.7003, lat: -31.6401, zoom: 16.8, pitch: 58, bearing: 24 },
  { id: 'mixed-rise', lng: -60.6738, lat: -31.6237, zoom: 16.6, pitch: 56, bearing: 28 },
] as const

export type SantaFe3dDensity = 'full' | 'reduced' | 'off'

export const SANTA_FE_3D_SOURCE_IDS = SANTA_FE_3D_ASSET_PATHS.map(
  (_, index) => `${SANTA_FE_3D_SOURCE_PREFIX}-${index}`,
) as readonly string[]

export const SANTA_FE_3D_LAYER_IDS = SANTA_FE_3D_ASSET_PATHS.map(
  (_, index) => `${SANTA_FE_3D_LAYER_PREFIX}-${index}`,
) as readonly string[]

export function isInsideSantaFe3dBounds(point: { lng: number; lat: number }): boolean {
  const [west, south, east, north] = SANTA_FE_3D_BOUNDS
  return point.lng >= west && point.lng <= east && point.lat >= south && point.lat <= north
}

export function sameOriginPmtilesUrl(path: string, origin: string): string {
  if (!path.startsWith('/data/santa-fe-3d/') || !path.endsWith('.pmtiles')) {
    throw new Error(`INVALID_SANTA_FE_PMTILES_PATH:${path}`)
  }
  const absolute = new URL(path, origin)
  if (absolute.origin !== new URL(origin).origin) throw new Error('SANTA_FE_PMTILES_MUST_BE_SAME_ORIGIN')
  return `pmtiles://${absolute.toString()}`
}

export function santaFe3dSourceDefinition(path: string, origin: string): VectorSourceSpecification {
  return {
    type: 'vector',
    url: sameOriginPmtilesUrl(path, origin),
    attribution: SANTA_FE_3D_ATTRIBUTION,
  }
}

export function santaFe3dLayerDefinition(
  sourceId: string,
  layerId: string,
  density: Exclude<SantaFe3dDensity, 'off'>,
): FillExtrusionLayerSpecification {
  return {
    id: layerId,
    type: 'fill-extrusion',
    source: sourceId,
    'source-layer': SANTA_FE_3D_SOURCE_LAYER,
    minzoom: density === 'reduced' ? 15 : 13,
    filter: ['>=', ['to-number', ['get', 'height'], 0], 3],
    layout: { visibility: 'none' },
    paint: {
      'fill-extrusion-color': [
        'interpolate',
        ['linear'],
        ['to-number', ['get', 'height'], 6],
        3, '#e6e7e3',
        8, '#daddd9',
        15, '#cdd1d2',
        30, '#bbc1c5',
        60, '#a9b1b8',
        100, '#9da7b0',
        180, '#8e99a4',
      ],
      'fill-extrusion-height': ['max', 3, ['to-number', ['get', 'height'], 6]],
      'fill-extrusion-base': [
        'min',
        ['max', 0, ['to-number', ['get', 'min_height'], 0]],
        ['-', ['max', 3, ['to-number', ['get', 'height'], 6]], 0.25],
      ],
      'fill-extrusion-opacity': density === 'reduced' ? 0.82 : 0.94,
      'fill-extrusion-vertical-gradient': true,
    },
  }
}

export function santaFe3dManifestContract(): {
  assetCount: number
  featureCount: number
  sourceLayer: string
  bounds: readonly [number, number, number, number]
} {
  return {
    assetCount: SANTA_FE_3D_ASSET_PATHS.length,
    featureCount: SANTA_FE_3D_FEATURE_COUNT,
    sourceLayer: SANTA_FE_3D_SOURCE_LAYER,
    bounds: SANTA_FE_3D_BOUNDS,
  }
}
