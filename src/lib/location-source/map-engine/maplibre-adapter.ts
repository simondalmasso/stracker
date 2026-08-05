'use client'

import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
import { circlePolygon } from '../geo'
import type { BasemapMode } from '../contracts'
import type { CameraUpdate, MapEngineAdapter, MapEngineCallbacks, MapPerformanceSnapshot, MapRenderState } from './contracts'
import {
  configureBuildings3d,
  OPENFREEMAP_ATTRIBUTION,
  OPENFREEMAP_STYLE_URL,
  setDarkBaseStyle,
  setLightCityBaseStyle,
} from './openfreemap-style'
import { SATELLITE_LAYER_ID, SATELLITE_PROVIDER, SATELLITE_SOURCE_ID, usesSatelliteImagery } from './satellite-provider'
import { SANTA_FE_3D_LAYER_IDS } from './santa-fe-city-config'
import {
  acquireSantaFePmtilesProtocol,
  configureSantaFeCity3d,
  isSantaFe3dSourceId,
  removeSantaFeCity3d,
} from './santa-fe-city-runtime'

const SOURCE_MARKER = 'stracker-marker'
const SOURCE_ACCURACY = 'stracker-accuracy'
const SOURCE_RAIL = 'stracker-ghostrail'
const RUNTIME_LAYER_IDS = new Set([
  'stracker-accuracy-fill',
  'stracker-accuracy-line',
  'stracker-ghostrail-line',
  'stracker-marker-halo',
  'stracker-marker',
  'stracker-buildings-3d',
  ...SANTA_FE_3D_LAYER_IDS,
  SATELLITE_LAYER_ID,
])

function emptyFeatureCollection(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] }
}

function markerData(state: MapRenderState): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {
        motion: state.motion,
        freshness: state.freshness,
        health: state.health,
      },
      geometry: { type: 'Point', coordinates: [state.point.lng, state.point.lat] },
    }],
  }
}

function accuracyData(state: MapRenderState): GeoJSON.FeatureCollection {
  if (state.accuracyM === null || state.accuracyM <= 0) return emptyFeatureCollection()
  return { type: 'FeatureCollection', features: [circlePolygon(state.point, state.accuracyM)] }
}

function railData(state: MapRenderState): GeoJSON.FeatureCollection {
  const coordinates = state.ghostrail
    .filter((segment) => segment.source === state.source && segment.points.length >= 2)
    .map((segment) => segment.points.map((point) => [point.lng, point.lat]))
  if (!coordinates.length) return emptyFeatureCollection()
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiLineString', coordinates },
    }],
  }
}

function setSourceData(map: MapLibreMap, id: string, data: GeoJSON.FeatureCollection): void {
  const source = map.getSource(id) as GeoJSONSource | undefined
  source?.setData(data)
}

function addRuntimeLayers(map: MapLibreMap, state: MapRenderState): void {
  if (!map.getSource(SOURCE_RAIL)) map.addSource(SOURCE_RAIL, { type: 'geojson', data: railData(state), lineMetrics: true })
  if (!map.getSource(SOURCE_ACCURACY)) map.addSource(SOURCE_ACCURACY, { type: 'geojson', data: accuracyData(state) })
  if (!map.getSource(SOURCE_MARKER)) map.addSource(SOURCE_MARKER, { type: 'geojson', data: markerData(state) })

  if (!map.getLayer('stracker-accuracy-fill')) {
    map.addLayer({
      id: 'stracker-accuracy-fill',
      type: 'fill',
      source: SOURCE_ACCURACY,
      paint: { 'fill-color': '#8ba8bd', 'fill-opacity': 0.09 },
    })
  }
  if (!map.getLayer('stracker-accuracy-line')) {
    map.addLayer({
      id: 'stracker-accuracy-line',
      type: 'line',
      source: SOURCE_ACCURACY,
      paint: { 'line-color': '#647784', 'line-opacity': 0.42, 'line-width': 1 },
    })
  }
  if (!map.getLayer('stracker-ghostrail-line')) {
    map.addLayer({
      id: 'stracker-ghostrail-line',
      type: 'line',
      source: SOURCE_RAIL,
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: state.railVisible ? 'visible' : 'none' },
      paint: {
        'line-color': '#e85d68',
        'line-opacity': 0.84,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 18, 4],
      },
    })
  }
  if (!map.getLayer('stracker-marker-halo')) {
    map.addLayer({
      id: 'stracker-marker-halo',
      type: 'circle',
      source: SOURCE_MARKER,
      paint: {
        'circle-radius': ['case', ['==', ['get', 'health'], 'receiving'], 18, 14],
        'circle-color': '#ffffff',
        'circle-opacity': ['case', ['==', ['get', 'health'], 'receiving'], 0.24, 0.1],
        'circle-blur': 0.5,
      },
    })
  }
  if (!map.getLayer('stracker-marker')) {
    map.addLayer({
      id: 'stracker-marker',
      type: 'circle',
      source: SOURCE_MARKER,
      paint: {
        'circle-radius': 8,
        'circle-color': '#ffffff',
        'circle-stroke-color': '#101418',
        'circle-stroke-width': 3,
      },
    })
  }
}

function addSatelliteLayer(map: MapLibreMap): void {
  if (!map.getSource(SATELLITE_SOURCE_ID)) {
    map.addSource(SATELLITE_SOURCE_ID, {
      type: 'raster',
      tiles: [SATELLITE_PROVIDER.tileTemplate],
      tileSize: 256,
      minzoom: 0,
      maxzoom: SATELLITE_PROVIDER.maxZoom,
      attribution: SATELLITE_PROVIDER.attribution,
    })
  }
  if (!map.getLayer(SATELLITE_LAYER_ID)) {
    const firstNonBackgroundLayer = map.getStyle().layers?.find((layer) => layer.type !== 'background')?.id
    map.addLayer({
      id: SATELLITE_LAYER_ID,
      type: 'raster',
      source: SATELLITE_SOURCE_ID,
      layout: { visibility: 'none' },
      paint: {
        'raster-opacity': 1,
        'raster-fade-duration': 0,
        'raster-resampling': 'linear',
      },
    }, firstNonBackgroundLayer)
  }
}

function resourceHost(name: string): string | null {
  try {
    return new URL(name).hostname
  } catch {
    return null
  }
}

function performanceSnapshot(
  latestState: MapRenderState | null,
  createdAtMs: number,
  firstMapVisibleMs: number | null,
  firstInteractiveMs: number | null,
  renderFrames: number,
  fpsWindowStart: number,
  longTasks: number,
  longTaskDurationMs: number,
  webglContextLosses: number,
  webglContextRestores: number,
): MapPerformanceSnapshot {
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  const transferredBytes = resources.reduce((total, resource) => total + (resource.transferSize || resource.encodedBodySize || 0), 0)
  const rasterResources = resources.filter((resource) => resourceHost(resource.name) === SATELLITE_PROVIDER.host)
  const rasterTransferredBytes = rasterResources.reduce((total, resource) => total + (resource.transferSize || resource.encodedBodySize || 0), 0)
  const elapsed = Math.max(1, performance.now() - fpsWindowStart)
  return {
    engine: 'maplibre',
    basemapMode: latestState?.basemapMode ?? 'vector-3d',
    createdAtMs,
    firstMapVisibleMs,
    firstInteractiveMs,
    renderFrames,
    estimatedFps: renderFrames ? Math.round((renderFrames * 1000) / elapsed) : null,
    longTasks,
    longTaskDurationMs,
    webglContextLosses,
    webglContextRestores,
    resourceCount: resources.length,
    transferredBytes,
    rasterResourceCount: rasterResources.length,
    rasterTransferredBytes,
  }
}

export function createMapLibreAdapter(): MapEngineAdapter {
  let map: MapLibreMap | null = null
  let callbacks: MapEngineCallbacks | null = null
  let latestState: MapRenderState | null = null
  let loaded = false
  let contextLostActive = false
  let satelliteFailureActive = false
  let satelliteAvailabilityTimer: ReturnType<typeof setTimeout> | null = null
  let appliedBasemapMode: BasemapMode | null = null
  let appliedVectorTheme: 'dark' | 'light-city' | null = null
  let releasePmtilesProtocol: (() => void) | null = null
  let createdAtMs = 0
  let firstMapVisibleMs: number | null = null
  let firstInteractiveMs: number | null = null
  let renderFrames = 0
  let fpsWindowStart = 0
  let longTasks = 0
  let longTaskDurationMs = 0
  let webglContextLosses = 0
  let webglContextRestores = 0
  let performanceObserver: PerformanceObserver | null = null
  let performanceTimer: ReturnType<typeof setInterval> | null = null
  const baseLayerVisibility = new Map<string, 'visible' | 'none'>()

  const clearSatelliteAvailabilityTimer = () => {
    if (satelliteAvailabilityTimer) clearTimeout(satelliteAvailabilityTimer)
    satelliteAvailabilityTimer = null
  }

  const markSatelliteUnavailable = () => {
    clearSatelliteAvailabilityTimer()
    satelliteFailureActive = true
    callbacks?.onBasemapProviderState('unavailable')
  }

  const markSatelliteAvailable = () => {
    clearSatelliteAvailabilityTimer()
    if (satelliteFailureActive) return
    callbacks?.onBasemapProviderState('available')
  }

  const emitPerformance = () => {
    if (!callbacks) return
    callbacks.onPerformance(performanceSnapshot(
      latestState,
      createdAtMs,
      firstMapVisibleMs,
      firstInteractiveMs,
      renderFrames,
      fpsWindowStart,
      longTasks,
      longTaskDurationMs,
      webglContextLosses,
      webglContextRestores,
    ))
  }

  const captureBaseVisibility = () => {
    if (!map || baseLayerVisibility.size > 0) return
    for (const layer of map.getStyle().layers ?? []) {
      if (RUNTIME_LAYER_IDS.has(layer.id)) continue
      const visibility = layer.layout && 'visibility' in layer.layout && layer.layout.visibility === 'none' ? 'none' : 'visible'
      baseLayerVisibility.set(layer.id, visibility)
    }
  }

  const applyBuildingPresentation = (mode: BasemapMode) => {
    if (!map || !latestState) return
    const vectorBuildingsEnabled = mode === 'vector-3d' && latestState.buildings3d
    const center = map.getCenter()
    const density = latestState.reducedMotion ? 'reduced' : 'full'
    const customVisible = configureSantaFeCity3d(map, {
      enabled: vectorBuildingsEnabled,
      density,
      center: { lng: center.lng, lat: center.lat },
      origin: window.location.origin,
    })
    configureBuildings3d(map, {
      enabled: vectorBuildingsEnabled && !customVisible,
      density,
    })

    if (mode === 'vector-3d') {
      const theme = vectorBuildingsEnabled ? 'light-city' : 'dark'
      if (theme !== appliedVectorTheme) {
        if (theme === 'light-city') setLightCityBaseStyle(map)
        else setDarkBaseStyle(map)
        appliedVectorTheme = theme
      }
    }
  }

  const applyBasemapMode = (mode: BasemapMode) => {
    if (!map) return
    addSatelliteLayer(map)
    const satelliteVisible = usesSatelliteImagery(mode)
    map.setLayoutProperty(SATELLITE_LAYER_ID, 'visibility', satelliteVisible ? 'visible' : 'none')

    for (const layer of map.getStyle().layers ?? []) {
      if (!baseLayerVisibility.has(layer.id)) continue
      const original = baseLayerVisibility.get(layer.id) ?? 'visible'
      const hybridOverlay = mode === 'hybrid' && (layer.type === 'line' || layer.type === 'symbol')
      const visibility = mode === 'vector-3d' ? original : hybridOverlay ? original : 'none'
      map.setLayoutProperty(layer.id, 'visibility', visibility)
    }

    clearSatelliteAvailabilityTimer()
    if (satelliteVisible) {
      satelliteFailureActive = false
      callbacks?.onBasemapProviderState('loading')
      satelliteAvailabilityTimer = setTimeout(() => {
        if (latestState && usesSatelliteImagery(latestState.basemapMode) && !satelliteFailureActive) markSatelliteUnavailable()
      }, 8_000)
      if (map.isSourceLoaded(SATELLITE_SOURCE_ID)) markSatelliteAvailable()
    } else {
      satelliteFailureActive = false
      callbacks?.onBasemapProviderState('idle')
    }

    applyBuildingPresentation(mode)
    appliedBasemapMode = mode
  }

  const handleContextLost = (event?: Event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    if (contextLostActive) return
    contextLostActive = true
    webglContextLosses += 1
    callbacks?.onProviderState('degraded')
    callbacks?.onWebglContextLost()
    emitPerformance()
  }

  const handleContextRestored = () => {
    if (!contextLostActive) return
    contextLostActive = false
    webglContextRestores += 1
    callbacks?.onWebglContextRestored()
    const currentMap = map
    const currentState = latestState
    if (currentMap && currentState && currentMap.isStyleLoaded()) {
      applyBasemapMode(currentState.basemapMode)
      addRuntimeLayers(currentMap, currentState)
      adapter.render(currentState)
      callbacks?.onProviderState('available')
    }
    emitPerformance()
  }

  const adapter: MapEngineAdapter = {
    id: 'maplibre',
    mount(container, initial, nextCallbacks) {
      if (map) adapter.destroy()
      callbacks = nextCallbacks
      callbacks.onProviderState('loading')
      callbacks.onBasemapProviderState(initial.basemapMode === 'vector-3d' ? 'idle' : 'loading')
      latestState = initial
      loaded = false
      contextLostActive = false
      satelliteFailureActive = false
      appliedBasemapMode = null
      appliedVectorTheme = null
      clearSatelliteAvailabilityTimer()
      createdAtMs = performance.now()
      fpsWindowStart = createdAtMs
      performance.clearResourceTimings()
      releasePmtilesProtocol = acquireSantaFePmtilesProtocol()

      map = new maplibregl.Map({
        container,
        style: OPENFREEMAP_STYLE_URL,
        center: [initial.point.lng, initial.point.lat],
        zoom: 16.3,
        pitch: initial.buildings3d ? 56 : 0,
        bearing: initial.buildings3d ? 25 : 0,
        minZoom: 3,
        maxZoom: 20,
        maxPitch: 65,
        attributionControl: false,
        cooperativeGestures: false,
        fadeDuration: initial.reducedMotion ? 0 : 180,
      })
      map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: OPENFREEMAP_ATTRIBUTION }), 'bottom-left')

      map.on('error', (event) => {
        const candidate = event as {
          sourceId?: string
          error?: Error & { status?: number; url?: string }
          tile?: { request?: { url?: string } }
        }
        const message = candidate.error?.message ?? ''
        const errorUrl = candidate.error?.url ?? candidate.tile?.request?.url ?? ''
        const satelliteModeActive = Boolean(latestState && usesSatelliteImagery(latestState.basemapMode))
        const satelliteError = satelliteModeActive && (
          candidate.sourceId === SATELLITE_SOURCE_ID ||
          message.includes(SATELLITE_PROVIDER.host) ||
          errorUrl.includes(SATELLITE_PROVIDER.host)
        )
        if (satelliteError) {
          markSatelliteUnavailable()
          return
        }
        if (isSantaFe3dSourceId(candidate.sourceId) || errorUrl.includes('/data/santa-fe-3d/')) {
          callbacks?.onProviderState('degraded')
          return
        }
        callbacks?.onProviderState('degraded')
      })
      map.on('sourcedata', (event) => {
        if (event.sourceId !== SATELLITE_SOURCE_ID || !event.isSourceLoaded || satelliteFailureActive) return
        if (latestState && usesSatelliteImagery(latestState.basemapMode)) markSatelliteAvailable()
      })
      map.once('style.load', () => {
        if (!map || !latestState) return
        captureBaseVisibility()
        setDarkBaseStyle(map)
        appliedVectorTheme = 'dark'
        addSatelliteLayer(map)
        applyBasemapMode(latestState.basemapMode)
        addRuntimeLayers(map, latestState)
      })
      map.once('load', () => {
        loaded = true
        firstMapVisibleMs = performance.now() - createdAtMs
        callbacks?.onProviderState('available')
        if (map && latestState) adapter.render(latestState)
        emitPerformance()
      })
      map.once('idle', () => {
        firstInteractiveMs = performance.now() - createdAtMs
        callbacks?.onProviderState('available')
        if (latestState && usesSatelliteImagery(latestState.basemapMode) && !satelliteFailureActive && map?.isSourceLoaded(SATELLITE_SOURCE_ID)) {
          markSatelliteAvailable()
        }
        emitPerformance()
      })
      map.on('render', () => { renderFrames += 1 })
      map.on('moveend', () => {
        if (map && latestState && map.isStyleLoaded()) applyBuildingPresentation(latestState.basemapMode)
      })
      for (const eventName of ['dragstart', 'rotatestart', 'pitchstart', 'zoomstart'] as const) {
        map.on(eventName, (event) => {
          if (event.originalEvent) callbacks?.onManualInteraction()
        })
      }

      const canvas = map.getCanvas()
      canvas.addEventListener('webglcontextlost', handleContextLost, { capture: true })
      canvas.addEventListener('webglcontextrestored', handleContextRestored, { capture: true })

      if ('PerformanceObserver' in window) {
        try {
          performanceObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              longTasks += 1
              longTaskDurationMs += entry.duration
            }
          })
          performanceObserver.observe({ type: 'longtask', buffered: true })
        } catch {
          performanceObserver = null
        }
      }
      performanceTimer = setInterval(emitPerformance, 5_000)
    },
    render(state) {
      latestState = state
      if (!map || contextLostActive) return
      if (map.isStyleLoaded()) {
        if (appliedBasemapMode !== state.basemapMode) applyBasemapMode(state.basemapMode)
        else applyBuildingPresentation(state.basemapMode)
      }
      if (!loaded) return
      setSourceData(map, SOURCE_MARKER, markerData(state))
      setSourceData(map, SOURCE_ACCURACY, accuracyData(state))
      setSourceData(map, SOURCE_RAIL, railData(state))
      if (map.getLayer('stracker-ghostrail-line')) {
        map.setLayoutProperty('stracker-ghostrail-line', 'visibility', state.railVisible ? 'visible' : 'none')
      }
      emitPerformance()
    },
    updateCamera(update: CameraUpdate) {
      if (!map || !update.shouldMove || contextLostActive) return
      const offsetY = Math.round(map.getContainer().clientHeight * update.offsetYRatio)
      const satelliteMode = latestState ? usesSatelliteImagery(latestState.basemapMode) : false
      const options = {
        center: [update.center.lng, update.center.lat] as [number, number],
        zoom: update.zoom,
        pitch: satelliteMode ? Math.min(update.pitchDeg, 35) : update.pitchDeg,
        bearing: update.bearingDeg ?? map.getBearing(),
        offset: [0, offsetY] as [number, number],
        duration: update.durationMs,
        essential: false,
      }
      if (update.animate) map.easeTo(options)
      else map.jumpTo(options)
    },
    resize() { map?.resize() },
    destroy() {
      clearSatelliteAvailabilityTimer()
      if (performanceTimer) clearInterval(performanceTimer)
      performanceTimer = null
      performanceObserver?.disconnect()
      performanceObserver = null
      if (map) {
        map.stop()
        if (map.isStyleLoaded()) removeSantaFeCity3d(map)
        map.remove()
      }
      releasePmtilesProtocol?.()
      releasePmtilesProtocol = null
      map = null
      callbacks = null
      latestState = null
      loaded = false
      contextLostActive = false
      satelliteFailureActive = false
      appliedBasemapMode = null
      appliedVectorTheme = null
      baseLayerVisibility.clear()
    },
  }
  return adapter
}
