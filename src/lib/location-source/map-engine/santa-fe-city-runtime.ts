'use client'

import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl'
import { PMTiles, Protocol } from 'pmtiles'
import { SANTA_FE_3D_ASSET_PATHS, SANTA_FE_3D_SOURCE_LAYER } from './santa-fe-3d-generated'
import {
  SANTA_FE_3D_LAYER_IDS,
  SANTA_FE_3D_PUBLIC_HEALTH_MIN_RENDERED_FEATURES,
  SANTA_FE_3D_SOURCE_IDS,
  isInsideSantaFe3dBounds,
  santaFe3dLayerDefinition,
  santaFe3dSourceDefinition,
  type SantaFe3dDensity,
} from './santa-fe-city-config'
import { configureBuildings3d } from './openfreemap-style'
import { SameOriginQueryRangeSource } from './pmtiles-query-source'

let protocol: Protocol | null = null
let protocolUsers = 0
let protocolRegistered = false
const registeredArchiveUrls = new Set<string>()
const HEALTH_PROBE_INTERVAL_MS = 250

export type SantaFe3dProviderState = '3D_LOADING' | '3D_ACTIVE' | '3D_FALLBACK' | '3D_UNAVAILABLE' | '3D_OFF'

export interface SantaFe3dRuntimeStatus {
  eligible: boolean
  configured: boolean
  sourceLoaded: boolean
  sourceBacked: boolean
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
  sourceBacked: boolean
  maxSourceLoadedCount: number
  styleSignature: string
  styleGeneration: number
  probeQueued: boolean
  probeTimer: ReturnType<typeof setTimeout> | null
  lastProbeAtMs: number
  observersInstalled: boolean
  lastOptions: SantaFe3dRuntimeOptions | null
  statusObserver: MutationObserver | null
  statusElement: HTMLElement | null
  latestStatus: SantaFe3dRuntimeStatus | null
}

const healthByMap = new WeakMap<MapLibreMap, RuntimeHealthMemory>()
const STATUS_ATTRIBUTE_NAMES = [
  'data-buildings-3d-state',
  'data-custom-source-count',
  'data-custom-source-loaded-count',
  'data-custom-source-backed',
  'data-custom-layer-count',
  'data-custom-rendered-features',
  'data-custom-query-source-features',
  'data-generic-fallback-visible',
  'data-map-style-generation',
] as const

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
      sourceBacked: false,
      maxSourceLoadedCount: 0,
      styleSignature: signature,
      styleGeneration: 1,
      probeQueued: false,
      probeTimer: null,
      lastProbeAtMs: 0,
      observersInstalled: false,
      lastOptions: null,
      statusObserver: null,
      statusElement: null,
      latestStatus: null,
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
    existing.sourceBacked = false
    existing.maxSourceLoadedCount = 0
  }
  return existing
}

function queueHealthProbe(map: MapLibreMap, memory: RuntimeHealthMemory): void {
  if (memory.probeQueued || !memory.lastOptions) return
  memory.probeQueued = true
  const elapsed = performance.now() - memory.lastProbeAtMs
  const delay = Math.max(0, HEALTH_PROBE_INTERVAL_MS - elapsed)
  const run = () => {
    memory.probeTimer = null
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      memory.probeQueued = false
      const options = memory.lastOptions
      if (!options || !map.isStyleLoaded()) return
      memory.lastProbeAtMs = performance.now()
      configureSantaFeCity3d(map, options)
    }))
  }
  if (delay > 0) memory.probeTimer = setTimeout(run, delay)
  else run()
}

function installHealthObservers(map: MapLibreMap, memory: RuntimeHealthMemory): void {
  if (memory.observersInstalled) return
  memory.observersInstalled = true
  map.on('sourcedata', (event) => {
    if (!isSantaFe3dSourceId(event.sourceId)) return
    queueHealthProbe(map, memory)
  })
  map.on('render', () => {
    if (memory.latestStatus?.eligible && memory.latestStatus.providerState !== '3D_ACTIVE') queueHealthProbe(map, memory)
  })
  map.on('idle', () => {
    if (memory.latestStatus?.eligible && memory.latestStatus.providerState !== '3D_ACTIVE') queueHealthProbe(map, memory)
  })
}

function safeRenderedFeatureCount(map: MapLibreMap, layerIds: string[]): number {
  if (!layerIds.length) return 0
  try { return map.queryRenderedFeatures({ layers: layerIds }).length } catch { return 0 }
}

function safeSourceFeatureCount(map: MapLibreMap, sourceIds: string[]): number {
  let total = 0
  for (const sourceId of sourceIds) {
    try {
      total += map.querySourceFeatures(sourceId, { sourceLayer: SANTA_FE_3D_SOURCE_LAYER })
        .filter((feature) => Number(feature.properties?.height) >= 3)
        .length
    } catch {}
  }
  return total
}

function ensureCustomLayerPresentation(map: MapLibreMap, layerIds: string[], desiredOpacity: number): boolean {
  let changed = false
  for (const layerId of layerIds) {
    if (map.getLayoutProperty(layerId, 'visibility') !== 'visible') {
      map.setLayoutProperty(layerId, 'visibility', 'visible')
      changed = true
    }
    const currentOpacity = Number(map.getPaintProperty(layerId, 'fill-extrusion-opacity'))
    if (!Number.isFinite(currentOpacity) || Math.abs(currentOpacity - desiredOpacity) > 0.0001) {
      map.setPaintProperty(layerId, 'fill-extrusion-opacity', desiredOpacity)
      changed = true
    }
  }
  return changed
}

function statusLabel(state: SantaFe3dProviderState): string {
  return ({
    '3D_LOADING': '3D CARGANDO · CIUDAD SANTA FE',
    '3D_ACTIVE': '3D ACTIVO · CIUDAD SANTA FE',
    '3D_FALLBACK': '3D RESPALDO · EDIFICIOS GENÉRICOS',
    '3D_UNAVAILABLE': '3D NO DISPONIBLE',
    '3D_OFF': '3D DESACTIVADO',
  } as const)[state]
}

function setDatasetValue(element: HTMLElement, key: string, value: string): void {
  if (element.dataset[key] !== value) element.dataset[key] = value
}

function applyStatusDataset(element: HTMLElement, status: SantaFe3dRuntimeStatus): void {
  if (element.getAttribute('data-buildings-3d-state') !== status.providerState) element.setAttribute('data-buildings-3d-state', status.providerState)
  element.removeAttribute('data-buildings3d-state')
  setDatasetValue(element, 'customSourceCount', String(status.customSourceCount))
  setDatasetValue(element, 'customSourceLoadedCount', String(status.customSourceLoadedCount))
  setDatasetValue(element, 'customSourceBacked', status.sourceBacked ? 'true' : 'false')
  setDatasetValue(element, 'customLayerCount', String(status.customLayerCount))
  setDatasetValue(element, 'customRenderedFeatures', String(status.customRenderedFeatureCount))
  setDatasetValue(element, 'customQuerySourceFeatures', String(status.customQuerySourceFeatureCount))
  setDatasetValue(element, 'genericFallbackVisible', status.genericFallbackVisible ? 'true' : 'false')
  setDatasetValue(element, 'mapStyleGeneration', String(status.styleGeneration))
}

function bindReactStableStatusDataset(map: MapLibreMap, status: SantaFe3dRuntimeStatus): void {
  const memory = memoryFor(map)
  const main = map.getContainer().closest('main[data-map-engine="maplibre"]')
  if (!(main instanceof HTMLElement)) return
  memory.latestStatus = status
  if (memory.statusElement !== main) {
    memory.statusObserver?.disconnect()
    memory.statusElement = main
    memory.statusObserver = new MutationObserver(() => {
      if (memory.statusElement && memory.latestStatus) applyStatusDataset(memory.statusElement, memory.latestStatus)
    })
    memory.statusObserver.observe(main, { attributes: true, attributeFilter: [...STATUS_ATTRIBUTE_NAMES] })
  }
  applyStatusDataset(main, status)
}

function publishStatus(map: MapLibreMap, status: SantaFe3dRuntimeStatus): void {
  const container = map.getContainer()
  bindReactStableStatusDataset(map, status)
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
  applyStatusDataset(badge, status)
  window.dispatchEvent(new CustomEvent('stracker:buildings-3d-state', { detail: status }))
}

function hideCustomLayers(map: MapLibreMap): number {
  let count = 0
  for (const layerId of SANTA_FE_3D_LAYER_IDS) {
    if (!map.getLayer(layerId)) continue
    count += 1
    if (map.getLayoutProperty(layerId, 'visibility') !== 'none') map.setLayoutProperty(layerId, 'visibility', 'none')
  }
  return count
}

export function configureSantaFeCity3d(map: MapLibreMap, options: SantaFe3dRuntimeOptions): boolean {
  const inside = isInsideSantaFe3dBounds(options.center)
  const eligible = options.enabled && options.density !== 'off' && inside
  const density: Exclude<SantaFe3dDensity, 'off'> = options.density === 'off' ? 'reduced' : options.density
  const memory = memoryFor(map)
  memory.lastOptions = { enabled: options.enabled, density: options.density, center: { ...options.center }, origin: options.origin }
  installHealthObservers(map, memory)

  if (!eligible) {
    const customLayerCount = hideCustomLayers(map)
    memory.consecutiveHealthy = 0
    memory.consecutiveEmpty = 0
    memory.healthy = false
    memory.sourceBacked = false
    memory.maxSourceLoadedCount = 0
    const fallbackVisible = options.enabled && options.density !== 'off'
    configureBuildings3d(map, { enabled: fallbackVisible, density })
    publishStatus(map, {
      eligible: false,
      configured: customLayerCount > 0,
      sourceLoaded: false,
      sourceBacked: false,
      rendered: false,
      healthy: false,
      providerState: fallbackVisible ? '3D_FALLBACK' : '3D_OFF',
      customSourceCount: SANTA_FE_3D_SOURCE_IDS.length,
      customSourceLoadedCount: 0,
      customLayerCount,
      customRenderedFeatureCount: 0,
      customQuerySourceFeatureCount: 0,
      genericFallbackVisible: fallbackVisible,
      styleGeneration: memory.styleGeneration,
    })
    return false
  }

  ensureSantaFeCity(map, options.origin, density)
  const existingLayerIds = SANTA_FE_3D_LAYER_IDS.filter((layerId) => Boolean(map.getLayer(layerId)))
  const existingSourceIds = SANTA_FE_3D_SOURCE_IDS.filter((sourceId) => Boolean(map.getSource(sourceId)))
  const desiredOpacity = density === 'reduced' ? 0.82 : 0.94
  const presentationChanged = ensureCustomLayerPresentation(map, existingLayerIds, desiredOpacity)

  const loadedSourceIds = existingSourceIds.filter((sourceId) => {
    try { return map.isSourceLoaded(sourceId) } catch { return false }
  })
  const renderedFeatureCount = presentationChanged ? 0 : safeRenderedFeatureCount(map, existingLayerIds)
  const sourceFeatureCount = safeSourceFeatureCount(map, existingSourceIds)
  const allLayersPresent = existingLayerIds.length === SANTA_FE_3D_LAYER_IDS.length
  const sourceBackedNow = allLayersPresent && (loadedSourceIds.length > 0 || renderedFeatureCount > 0)
  if (sourceBackedNow) {
    memory.sourceBacked = true
    memory.maxSourceLoadedCount = Math.max(memory.maxSourceLoadedCount, loadedSourceIds.length)
  }
  const sourceBacked = memory.sourceBacked
  const healthyEvidence = sourceBacked && renderedFeatureCount >= SANTA_FE_3D_PUBLIC_HEALTH_MIN_RENDERED_FEATURES

  if (healthyEvidence) {
    memory.consecutiveHealthy += 1
    memory.consecutiveEmpty = 0
  } else {
    memory.consecutiveEmpty += 1
    memory.consecutiveHealthy = 0
  }
  memory.healthy = healthyEvidence
  configureBuildings3d(map, { enabled: !memory.healthy, density })

  if (!memory.healthy && (presentationChanged || sourceBacked || sourceFeatureCount > 0) && memory.consecutiveEmpty <= 120) {
    queueHealthProbe(map, memory)
  }

  const sourceLoaded = sourceBacked || loadedSourceIds.length > 0 || renderedFeatureCount > 0
  const providerState: SantaFe3dProviderState = memory.healthy ? '3D_ACTIVE' : '3D_FALLBACK'
  publishStatus(map, {
    eligible: true,
    configured: allLayersPresent,
    sourceLoaded,
    sourceBacked,
    rendered: renderedFeatureCount > 0,
    healthy: memory.healthy,
    providerState,
    customSourceCount: existingSourceIds.length,
    customSourceLoadedCount: Math.max(loadedSourceIds.length, memory.maxSourceLoadedCount),
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
  const memory = healthByMap.get(map)
  if (memory?.probeTimer) clearTimeout(memory.probeTimer)
  memory?.statusObserver?.disconnect()
  healthByMap.delete(map)
}
