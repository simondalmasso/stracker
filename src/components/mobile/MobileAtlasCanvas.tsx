'use client'

import { useEffect, useRef } from 'react'
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type Marker } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { LocationSnapshot } from '@/lib/location-source/contracts'

interface MobileAtlasCanvasProps {
  snapshot: LocationSnapshot
  ghostrail: LocationSnapshot[]
  satellite: boolean
  railVisible: boolean
  centerRequest: number
}

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'
const SATELLITE_SOURCE = 'stracker-satellite-source'
const SATELLITE_LAYER = 'stracker-satellite-layer'
const RAIL_SOURCE = 'stracker-ghostrail-source'
const RAIL_LAYER = 'stracker-ghostrail-layer'
const BUILDING_LAYER = 'stracker-isometric-buildings'

function railFeature(points: LocationSnapshot[]): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const coordinates = points
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
    .map((point) => [point.lng, point.lat] as [number, number])
  return {
    type: 'FeatureCollection',
    features: coordinates.length >= 2
      ? [{
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates },
        }]
      : [],
  }
}

export default function MobileAtlasCanvas({
  snapshot,
  ghostrail,
  satellite,
  railVisible,
  centerRequest,
}: MobileAtlasCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markerRef = useRef<Marker | null>(null)
  const snapshotRef = useRef(snapshot)
  const railRef = useRef(ghostrail)
  const satelliteRef = useRef(satellite)
  const railVisibleRef = useRef(railVisible)
  const baseLayerVisibilityRef = useRef<Record<string, string>>({})

  useEffect(() => {
    snapshotRef.current = snapshot
    railRef.current = ghostrail
    satelliteRef.current = satellite
    railVisibleRef.current = railVisible
  }, [snapshot, ghostrail, satellite, railVisible])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    const markerElement = document.createElement('div')
    markerElement.className = 'stracker-atlas-marker'
    markerElement.setAttribute('aria-label', 'Ubicación actual')
    markerElement.innerHTML = '<span></span>'

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [snapshotRef.current.lng, snapshotRef.current.lat],
      zoom: 16.5,
      pitch: 58,
      bearing: -24,
      minZoom: 3,
      maxZoom: 20,
      attributionControl: false,
      cooperativeGestures: true,
    })
    mapRef.current = map

    markerRef.current = new maplibregl.Marker({ element: markerElement, anchor: 'center' })
      .setLngLat([snapshotRef.current.lng, snapshotRef.current.lat])
      .addTo(map)

    map.on('load', () => {
      const initialLayers = map.getStyle().layers || []
      initialLayers.forEach((layer) => {
        const visibility =
          (map.getLayoutProperty(layer.id, 'visibility') as string | undefined) || 'visible'
        baseLayerVisibilityRef.current[layer.id] = visibility
        if (satelliteRef.current) map.setLayoutProperty(layer.id, 'visibility', 'none')
      })
      const firstSymbol = initialLayers.find((layer) => layer.type === 'symbol')?.id
      map.addSource(SATELLITE_SOURCE, {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        attribution: 'Imagery © Esri',
      })
      map.addLayer({
        id: SATELLITE_LAYER,
        type: 'raster',
        source: SATELLITE_SOURCE,
        layout: { visibility: satelliteRef.current ? 'visible' : 'none' },
        paint: { 'raster-opacity': 0.92 },
      }, firstSymbol)

      const style = map.getStyle()
      const buildingSource = style.sources?.openmaptiles
      const extrusionColor = [
        'match', ['get', 'class'],
        'commercial', '#b9c3cf',
        'industrial', '#a8b5c1',
        'residential', '#d1d7dd',
        '#c4ccd5',
      ] as maplibregl.ExpressionSpecification
      if (map.getLayer('building-3d')) {
        map.setPaintProperty('building-3d', 'fill-extrusion-color', extrusionColor)
        map.setPaintProperty('building-3d', 'fill-extrusion-opacity', 0.94)
      } else if (buildingSource && buildingSource.type === 'vector') {
        map.addLayer({
          id: BUILDING_LAYER,
          type: 'fill-extrusion',
          source: 'openmaptiles',
          'source-layer': 'building',
          minzoom: 14,
          paint: {
            'fill-extrusion-color': extrusionColor,
            'fill-extrusion-height': ['max', 3, ['coalesce', ['get', 'render_height'], ['get', 'height'], 3]],
            'fill-extrusion-base': ['max', 0, ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0]],
            'fill-extrusion-opacity': 0.94,
            'fill-extrusion-vertical-gradient': true,
          },
        }, firstSymbol)
        baseLayerVisibilityRef.current[BUILDING_LAYER] = 'visible'
        if (satelliteRef.current) map.setLayoutProperty(BUILDING_LAYER, 'visibility', 'none')
      }

      map.addSource(RAIL_SOURCE, {
        type: 'geojson',
        data: railFeature(railRef.current),
      })
      map.addLayer({
        id: RAIL_LAYER,
        type: 'line',
        source: RAIL_SOURCE,
        layout: { visibility: railVisibleRef.current ? 'visible' : 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#f7f9fc', 'line-width': 3, 'line-opacity': 0.82 },
      })
    })

    map.on('error', (event) => {
      if (event.error) console.warn('STRACKER atlas map resource unavailable')
    })

    return () => {
      markerRef.current?.remove()
      markerRef.current = null
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markerRef.current?.setLngLat([snapshot.lng, snapshot.lat])
    if (map.loaded()) {
      map.flyTo({
        center: [snapshot.lng, snapshot.lat],
        zoom: Math.max(map.getZoom(), 16),
        duration: centerRequest ? 450 : 0,
        essential: true,
      })
    }
  }, [snapshot.lat, snapshot.lng, centerRequest])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.getLayer(SATELLITE_LAYER)) return
    if (satellite) {
      for (const layer of map.getStyle().layers || []) {
        if (layer.id !== SATELLITE_LAYER && layer.id !== RAIL_LAYER) {
          map.setLayoutProperty(layer.id, 'visibility', 'none')
        }
      }
      map.setLayoutProperty(SATELLITE_LAYER, 'visibility', 'visible')
    } else {
      map.setLayoutProperty(SATELLITE_LAYER, 'visibility', 'none')
      for (const [id, visibility] of Object.entries(baseLayerVisibilityRef.current)) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility)
      }
    }
  }, [satellite])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.getLayer(RAIL_LAYER)) return
    map.setLayoutProperty(RAIL_LAYER, 'visibility', railVisible ? 'visible' : 'none')
    const source = map.getSource(RAIL_SOURCE) as GeoJSONSource | undefined
    source?.setData(railFeature(ghostrail))
  }, [ghostrail, railVisible])

  return <div ref={containerRef} className="stracker-maplibre-container absolute inset-0" aria-label="Atlas isométrico 2.5D de STRACKER" />
}
