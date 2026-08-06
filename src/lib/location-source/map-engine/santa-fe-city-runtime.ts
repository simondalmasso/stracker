'use client'

import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl'
import { PMTiles, Protocol } from 'pmtiles'
import { SANTA_FE_3D_ASSET_PATHS, SANTA_FE_3D_SOURCE_LAYER } from './santa-fe-3d-generated'
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

export type SantaFe3dProviderState = '3D_LOADING' | '3D_ACTIVE' | '3D_FALLBACK' | '3D_UNAVAILABLE' | '3D_OFF'

export interface SantaFe3dRuntimeStatus {
  eligible: boolean
  configured: boolean
  sourceLoaded: boolean
  rendered: boolean
  healthy: boolean
  providerState: SantaFe3dProviderState
  customSourceCount: number
  customSourceLoadedCount: number
  customLayerCount: number
  customRenderedFeatureCount: number
  customQuerySourceFeatureCount: number
  genericFallbackVisible: boolean
  styleGeneration: number
}

export interface SantaFe3dRuntimeOptions {
  enabled: boolean
  density: SantaFe3dDensity
  center: { lng: number; lat: number }
  origin: string
}

interface RuntimeHealthMemory {
  consecutiveHealthy: number
  consecutiveEmpty: number
  healthy: boolean
  styleSignature: string
  styleGeneration: number
  probeQueued: boolean
  observersInstalled: boolean
  lastOptions: SantaFe3dRuntimeOptions | null
}

const healthByMap = new WeakMap<MapLibreMap, RuntimeHealthMemory>()

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
    if (!map.getSource(sourceId)) map.addSource(sourceId, santaFe3dSourceDefinition(SANTA_FE_3D_ASSET_PATHS[index], origin))
    if (!map.getLayer(layerId)) map.addLayer(santaFe3dLayerDefinition(sourceId, layerId, density), before)
  }
}

function memoryFor(map: MapLibreMap): RuntimeHealthMemory {
  const style = map.getStyle()
  const signature = `${Object.keys(style.sources ?? {}).sort().join('|')}::${(style.layers ?? []).map((layer) => layer.id).join('|')}`
  const existing = healthByMap.get(map)
  if (!existing) {
    const created: RuntimeHealthMemory = {
      consecutiveHealthy: 0,
      consecutiveEmpty: 0,
      healthy: false,
      styleSignature: signature,
      styleGeneration: 1,
      probeQueued: false,
      observersInstalled: false,
      lastOptions: null,
    }
    healthByMap.set(map, created)
    return created
  }
  if (existing.styleSignature !== signature) {
    existing.styleSignature = signature
    existing.styleGeneration += 1
    existing.consecutiveHealthy = 0
    existing.consecutiveEmpty = 0
    existing.healthy = false
  }
  return existing
}

function queueHealthProbe(map: MapLibreMap, memory: RuntimeHealthMemory): void {
  if (memory.probeQueued || !memory.lastOptions) return
  memory.probeQueued = true
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    memory.probeQueued = false
    const options = memory.lastOptions
    if (!options || !map.isStyleLoaded()) return
    configureSantaFeCity3d(map, options)
  }))
}

function installHealthObservers(map: MapLibreMap, memory: RuntimeHealthMemory): void {
  if (memory.observersInstalled) return
  memory.observersInstalled = true
  map.on('sourcedata', (event) => {
    if (!isSantaFe3dSourceId(event.sourceId)) return
    queueHealthProbe(map, memory)
  })
  map.on('idle', () => {
    if (!memory.healthy || memory.consecutiveEmpty > 0) queueHealthProbe(map, memory)
  })
}

function safeRenderedFeatureCount(map: MapLibreMap, layerIds: string[]): number {
  if (!layerIds.length) return 0
  try { return map.queryRenderedFeatures({ layers: layerIds }).length } catch { return 0 }
}

function safeSourceFeatureCount(map: MapLibreMap, sourceIds: string[]): number {
  let total = 0
  for (const sourceId of sourceIds) {
    try { total += map.querySourceFeatures(sourceId, { sourceLayer: SANTA_FE_3D_SOURCE_LAYER }).length } catch {}
  }
  return total
}

function statusLabel(state: SantaFe3dProviderState): string {
  return ({
    '3D_LOADING': '3D CARGANDO · RESPALDO ACTIVO',
    '3D_ACTIVE': '3D ACTIVO · CIUDAD SANTA FE',
    '3D_FALLBACK': '3D RESPALDO · EDIFICIOS GENÉRICOS',
    '3D_UNAVAILABLE': '3D NO DISPONIBLE',
    '3D_OFF': '3D DESACTIVADO',
  } as const)[state]
}

function publishStatus(map: MapLibreMap, status: SantaFe3dRuntimeStatus): void {
  const container = map.getContainer()
  const main = container.closest('main[data-map-engine="maplibre"]')
  if (main instanceof HTMLElement) {
    main.dataset.buildings3dState = status.providerState
    main.dataset.customSourceCount = String(status.customSourceCount)
    main.dataset.customSourceLoadedCount = String(status.customSourceLoadedCount)
    main.dataset.customLayerCount = String(status.customLayerCount)
    main.dataset.customRenderedFeatures = String(status.customRenderedFeatureCount)
    main.dataset.customQuerySourceFeatures = String(status.customQuerySourceFeatureCount)
    main.dataset.genericFallbackVisible = status.genericFallbackVisible ? 'true' : 'false'
    main.dataset.mapStyleGeneration = String(status.styleGeneration)
  }
  let badge = container.querySelector<HTMLElement>('[data-stracker-3d-status]')
  if (!badge) {
    badge = document.createElement('div')
    badge.dataset.stracker3dStatus = 'true'
    badge.setAttribute('role', 'status')
    badge.style.position = 'absolute'
    badge.style.left = '12px'
    badge.style.bottom = '132px'
    badge.style.zIndex = '530'
    badge.style.maxWidth = 'calc(100% - 24px)'
    badge.style.border = '1px solid rgba(255,255,255,.14)'
    badge.style.borderRadius = '999px'
    badge.style.background = 'rgba(0,0,0,.82)'
    badge.style.padding = '6px 10px'
    badge.style.color = '#fff'
    badge.style.fontSize = '10px'
    badge.style.fontWeight = '700'
    badge.style.letterSpacing = '.04em'
    badge.style.pointerEvents = 'none'
    container.appendChild(badge)
  }
  badge.textContent = statusLabel(status.providerState)
  badge.dataset.state = status.providerState
  window.dispatchEvent(new CustomEvent('stracker:buildings-3d-state', { detail: status }))
}

function hideCustomLayers(map: MapLibreMap): number {
  let count = 0
  for (const layerId of SANTA_FE_3D_LAYER_IDS) {
    if (!map.getLayer(layerId)) continue
    count += 1
    map.setLayoutProperty(layerId, 'visibility', 'none')
  }
  return count
}

export function configureSantaFeCity3d(map: MapLibreMap, options: SantaFe3dRuntimeOptions): boolean {
  const inside = isInsideSantaFe3dBounds(options.center)
  const eligible = options.enabled && options.density !== 'off' && inside
  const memory = memoryFor(map)
  memory.lastOptions = { enabled: options.enabled, density: options.density, center: { ...options.center }, origin: options.origin }
  installHealthObservers(map, memory)

  if (!eligible) {
    const customLayerCount = hideCustomLayers(map)
    memory.consecutiveHealthy = 0
    memory.consecutiveEmpty = 0
    memory.healthy = false
    publishStatus(map, {
      eligible: false,
      configured: customLayerCount > 0,
      sourceLoaded: false,
      rendered: false,
      healthy: false,
      providerState: options.enabled && options.density !== 'off' ? '3D_FALLBACK' : '3D_OFF',
      customSourceCount: SANTA_FE_3D_SOURCE_IDS.length,
      customSourceLoadedCount: 0,
      customLayerCount,
      customRenderedFeatureCount: 0,
      customQuerySourceFeatureCount: 0,
      genericFallbackVisible: options.enabled && options.density !== 'off',
      styleGeneration: memory.styleGeneration,
    })
    return false
  }

  const density = options.density === 'off' ? 'reduced' : options.density
  ensureSantaFeCity(map, options.origin, density)
  const existingLayerIds = SANTA_FE_3D_LAYER_IDS.filter((layerId) => Boolean(map.getLayer(layerId)))
  const existingSourceIds = SANTA_FE_3D_SOURCE_IDS.filter((sourceId) => Boolean(map.getSource(sourceId)))
  const desiredOpacity = density === 'reduced' ? 0.82 : 0.94

  for (const layerId of existingLayerIds) {
    map.setLayoutProperty(layerId, 'visibility', 'visible')
    map.setPaintProperty(layerId, 'fill-extrusion-opacity', desiredOpacity)
  }

  const loadedSourceIds = existingSourceIds.filter((sourceId) => {
    try { return map.isSourceLoaded(sourceId) } catch { return false }
  })
  const renderedFeatureCount = safeRenderedFeatureCount(map, existingLayerIds)
  const sourceFeatureCount = safeSourceFeatureCount(map, existingSourceIds)

  if (renderedFeatureCount > 0) {
    memory.consecutiveHealthy += 1
    memory.consecutiveEmpty = 0
  } else {
    memory.consecutiveEmpty += 1
    memory.consecutiveHealthy = 0
  }
  if (!memory.healthy && memory.consecutiveHealthy >= 1) memory.healthy = true
  if (memory.healthy && memory.consecutiveEmpty >= 2) memory.healthy = false
  if (!memory.healthy && sourceFeatureCount > 0 && memory.consecutiveEmpty <= 8) {
    map.triggerRepaint()
    queueHealthProbe(map, memory)
  }

  const sourceLoaded = loadedSourceIds.length > 0
  const providerState: SantaFe3dProviderState = memory.healthy
    ? '3D_ACTIVE'
    : sourceLoaded || sourceFeatureCount > 0
      ? '3D_FALLBACK'
      : '3D_LOADING'
  publishStatus(map, {
    eligible: true,
    configured: existingLayerIds.length === SANTA_FE_3D_LAYER_IDS.length,
    sourceLoaded,
    rendered: renderedFeatureCount > 0,
    healthy: memory.healthy,
    providerState,
    customSourceCount: existingSourceIds.length,
    customSourceLoadedCount: loadedSourceIds.length,
    customLayerCount: existingLayerIds.length,
    customRenderedFeatureCount: renderedFeatureCount,
    customQuerySourceFeatureCount: sourceFeatureCount,
    genericFallbackVisible: !memory.healthy,
    styleGeneration: memory.styleGeneration,
  })
  return memory.healthy
}

export function isSantaFe3dSourceId(sourceId: string | undefined): boolean {
  return Boolean(sourceId && SANTA_FE_3D_SOURCE_IDS.includes(sourceId))
}

export function removeSantaFeCity3d(map: MapLibreMap): void {
  for (const layerId of [...SANTA_FE_3D_LAYER_IDS].reverse()) if (map.getLayer(layerId)) map.removeLayer(layerId)
  for (const sourceId of [...SANTA_FE_3D_SOURCE_IDS].reverse()) if (map.getSource(sourceId)) map.removeSource(sourceId)
  healthByMap.delete(map)
}
