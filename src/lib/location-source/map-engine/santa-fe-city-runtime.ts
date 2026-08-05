'use client'

import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl'
import { PMTiles, Protocol } from 'pmtiles'
import { SANTA_FE_3D_ASSET_PATHS } from './santa-fe-3d-generated'
import {
  SANTA_FE_3D_LAYER_IDS,
  SANTA_FE_3D_SOURCE_IDS,
  isInsideSantaFe3dBounds,
  santaFe3dLayerDefinition,
  santaFe3dSourceDefinition,
  type SantaFe3dDensity,
} from './santa-fe-city-config'
import { SameOriginQueryRangeSource } from './pmtiles-query-source'

let protocol: Protocol | null = null
let protocolUsers = 0
let protocolRegistered = false
const registeredArchiveUrls = new Set<string>()

export interface SantaFe3dRuntimeOptions {
  enabled: boolean
  density: SantaFe3dDensity
  center: { lng: number; lat: number }
  origin: string
}

function ensureSantaFeArchivesRegistered(): void {
  protocol ??= new Protocol()
  const origin = window.location.origin
  for (const path of SANTA_FE_3D_ASSET_PATHS) {
    const archiveUrl = new URL(path, origin).toString()
    if (registeredArchiveUrls.has(archiveUrl)) continue
    protocol.add(new PMTiles(new SameOriginQueryRangeSource(archiveUrl, origin)))
    registeredArchiveUrls.add(archiveUrl)
  }
}

export function acquireSantaFePmtilesProtocol(): () => void {
  ensureSantaFeArchivesRegistered()
  if (!protocolRegistered) {
    maplibregl.addProtocol('pmtiles', protocol!.tile)
    protocolRegistered = true
  }
  protocolUsers += 1
  let released = false
  return () => {
    if (released) return
    released = true
    protocolUsers = Math.max(0, protocolUsers - 1)
    if (protocolUsers === 0 && protocolRegistered) {
      maplibregl.removeProtocol('pmtiles')
      protocolRegistered = false
    }
  }
}

function firstSymbolLayerId(map: MapLibreMap): string | undefined {
  return (map.getStyle().layers ?? []).find((layer) => layer.type === 'symbol')?.id
}

function ensureSantaFeCity(map: MapLibreMap, origin: string, density: Exclude<SantaFe3dDensity, 'off'>): void {
  const before = firstSymbolLayerId(map)
  for (let index = 0; index < SANTA_FE_3D_ASSET_PATHS.length; index += 1) {
    const sourceId = SANTA_FE_3D_SOURCE_IDS[index]
    const layerId = SANTA_FE_3D_LAYER_IDS[index]
    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, santaFe3dSourceDefinition(SANTA_FE_3D_ASSET_PATHS[index], origin))
    }
    if (!map.getLayer(layerId)) {
      map.addLayer(santaFe3dLayerDefinition(sourceId, layerId, density), before)
    }
  }
}

export function configureSantaFeCity3d(map: MapLibreMap, options: SantaFe3dRuntimeOptions): boolean {
  const inside = isInsideSantaFe3dBounds(options.center)
  const visible = options.enabled && options.density !== 'off' && inside
  if (visible) ensureSantaFeCity(map, options.origin, options.density === 'off' ? 'reduced' : options.density)

  for (const layerId of SANTA_FE_3D_LAYER_IDS) {
    if (!map.getLayer(layerId)) continue
    map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
    if (visible) {
      map.setPaintProperty(layerId, 'fill-extrusion-opacity', options.density === 'reduced' ? 0.82 : 0.94)
    }
  }
  return visible
}

export function isSantaFe3dSourceId(sourceId: string | undefined): boolean {
  return Boolean(sourceId && SANTA_FE_3D_SOURCE_IDS.includes(sourceId))
}

export function removeSantaFeCity3d(map: MapLibreMap): void {
  for (const layerId of [...SANTA_FE_3D_LAYER_IDS].reverse()) {
    if (map.getLayer(layerId)) map.removeLayer(layerId)
  }
  for (const sourceId of [...SANTA_FE_3D_SOURCE_IDS].reverse()) {
    if (map.getSource(sourceId)) map.removeSource(sourceId)
  }
}
