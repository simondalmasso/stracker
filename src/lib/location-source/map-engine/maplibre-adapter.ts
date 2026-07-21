'use client'

import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
import { circlePolygon } from '../geo'
import type { CameraUpdate, MapEngineAdapter, MapEngineCallbacks, MapPerformanceSnapshot, MapRenderState } from './contracts'
import { configureBuildings3d, OPENFREEMAP_ATTRIBUTION, OPENFREEMAP_STYLE_URL, setDarkBaseStyle } from './openfreemap-style'

const SOURCE_MARKER = 'stracker-marker'
const SOURCE_ACCURACY = 'stracker-accuracy'
const SOURCE_RAIL = 'stracker-ghostrail'

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
      paint: { 'line-color': '#c8d6df', 'line-opacity': 0.34, 'line-width': 1 },
    })
  }
  if (!map.getLayer('stracker-ghostrail-line')) {
    map.addLayer({
      id: 'stracker-ghostrail-line',
      type: 'line',
      source: SOURCE_RAIL,
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: state.railVisible ? 'visible' : 'none' },
      paint: {
        'line-color': '#f5f7f8',
        'line-opacity': 0.74,
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
        'circle-opacity': ['case', ['==', ['get', 'health'], 'receiving'], 0.12, 0.04],
        'circle-blur': 0.55,
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
        'circle-stroke-color': '#050505',
        'circle-stroke-width': 3,
      },
    })
  }
}

function performanceSnapshot(
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
  const transferredBytes = resources.reduce((total, resource) => total + (resource.transferSize || 0), 0)
  const elapsed = Math.max(1, performance.now() - fpsWindowStart)
  return {
    engine: 'maplibre',
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
  }
}

export function createMapLibreAdapter(): MapEngineAdapter {
  let map: MapLibreMap | null = null
  let callbacks: MapEngineCallbacks | null = null
  let latestState: MapRenderState | null = null
  let loaded = false
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

  const emitPerformance = () => {
    if (!callbacks) return
    callbacks.onPerformance(performanceSnapshot(
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

  const adapter: MapEngineAdapter = {
    id: 'maplibre',
    mount(container, initial, nextCallbacks) {
      if (map) adapter.destroy()
      callbacks = nextCallbacks
      latestState = initial
      loaded = false
      createdAtMs = performance.now()
      fpsWindowStart = createdAtMs
      performance.clearResourceTimings()

      map = new maplibregl.Map({
        container,
        style: OPENFREEMAP_STYLE_URL,
        center: [initial.point.lng, initial.point.lat],
        zoom: 16,
        pitch: 0,
        bearing: 0,
        minZoom: 3,
        maxZoom: 20,
        maxPitch: 65,
        attributionControl: false,
        antialias: true,
        cooperativeGestures: false,
        fadeDuration: initial.reducedMotion ? 0 : 180,
      })
      map.addControl(new maplibregl.AttributionControl({ compact: false, customAttribution: OPENFREEMAP_ATTRIBUTION }), 'bottom-left')

      map.once('style.load', () => {
        if (!map || !latestState) return
        setDarkBaseStyle(map)
        addRuntimeLayers(map, latestState)
        configureBuildings3d(map, { enabled: latestState.buildings3d, density: 'full' })
      })
      map.once('load', () => {
        loaded = true
        firstMapVisibleMs = performance.now() - createdAtMs
        if (map && latestState) adapter.render(latestState)
        emitPerformance()
      })
      map.once('idle', () => {
        firstInteractiveMs = performance.now() - createdAtMs
        emitPerformance()
      })
      map.on('render', () => { renderFrames += 1 })
      for (const eventName of ['dragstart', 'rotatestart', 'pitchstart', 'zoomstart'] as const) {
        map.on(eventName, (event) => {
          if (event.originalEvent) callbacks?.onManualInteraction()
        })
      }

      const canvas = map.getCanvas()
      canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault()
        webglContextLosses += 1
        callbacks?.onWebglContextLost()
        emitPerformance()
      })
      canvas.addEventListener('webglcontextrestored', () => {
        webglContextRestores += 1
        callbacks?.onWebglContextRestored()
        if (map && latestState) {
          addRuntimeLayers(map, latestState)
          configureBuildings3d(map, { enabled: latestState.buildings3d, density: 'reduced' })
          adapter.render(latestState)
        }
        emitPerformance()
      })

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
      if (!map || !loaded) return
      setSourceData(map, SOURCE_MARKER, markerData(state))
      setSourceData(map, SOURCE_ACCURACY, accuracyData(state))
      setSourceData(map, SOURCE_RAIL, railData(state))
      if (map.getLayer('stracker-ghostrail-line')) {
        map.setLayoutProperty('stracker-ghostrail-line', 'visibility', state.railVisible ? 'visible' : 'none')
      }
      configureBuildings3d(map, { enabled: state.buildings3d, density: state.reducedMotion ? 'reduced' : 'full' })
    },
    updateCamera(update: CameraUpdate) {
      if (!map || !update.shouldMove) return
      const offsetY = Math.round(map.getContainer().clientHeight * update.offsetYRatio)
      const options = {
        center: [update.center.lng, update.center.lat] as [number, number],
        zoom: update.zoom,
        pitch: update.pitchDeg,
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
      if (performanceTimer) clearInterval(performanceTimer)
      performanceTimer = null
      performanceObserver?.disconnect()
      performanceObserver = null
      map?.stop()
      map?.remove()
      map = null
      callbacks = null
      latestState = null
      loaded = false
    },
  }
  return adapter
}
