'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Building2, Clock3, LocateFixed, Route, X } from 'lucide-react'
import type { BasemapMode, CameraMode, GhostRailSegment, LocationKeyframe, LocationSnapshot, LocationSource } from '@/lib/location-source/contracts'
import { initialCameraControllerState, planCamera, type CameraControllerState } from '@/lib/location-source/camera-controller'
import { createMapLibreAdapter } from '@/lib/location-source/map-engine/maplibre-adapter'
import type { BasemapProviderState, MapEngineAdapter, MapPerformanceSnapshot, MapProviderState, MapRenderState } from '@/lib/location-source/map-engine/contracts'
import { basemapLabel, SATELLITE_PROVIDER } from '@/lib/location-source/map-engine/satellite-provider'

interface MobileMapShellProps {
  source: LocationSource
  snapshot: LocationSnapshot
  ghostrail: GhostRailSegment[]
  keyframes?: LocationKeyframe[]
  onChangeSource: () => void
  onStop?: () => void
}

const BASEMAP_MODES: BasemapMode[] = ['vector-3d', 'satellite', 'hybrid']
const EVENT_LABELS: Record<LocationKeyframe['type'], string> = {
  session_observation_start: 'INICIO DE OBSERVACIÓN',
  movement_start: 'MOVIMIENTO INICIADO',
  movement_stop: 'MOVIMIENTO DETENIDO',
  dwell_start: 'PERMANENCIA INICIADA',
  dwell_end: 'PERMANENCIA FINALIZADA',
  significant_displacement: 'DESPLAZAMIENTO SIGNIFICATIVO',
  major_direction_change: 'CAMBIO DE DIRECCIÓN',
  mode_change: 'CAMBIO DE MODO / HIPÓTESIS',
  data_gap_start: 'INICIO DE GAP',
  data_gap_recovered: 'DATOS RECUPERADOS',
}

function freshnessText(snapshot: LocationSnapshot): string {
  if (snapshot.freshness === 'fresh') {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(snapshot.capturedAt)) / 1000))
    return seconds < 5 ? 'AHORA' : `HACE ${seconds}S`
  }
  if (snapshot.freshness === 'stale') {
    const minutes = Math.max(1, Math.round((Date.now() - Date.parse(snapshot.capturedAt)) / 60_000))
    return `STALE · ${minutes}MIN`
  }
  return snapshot.freshness === 'expired' ? 'VENCIDA' : 'DESCONOCIDA'
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return reduced
}

function renderState(source: LocationSource, snapshot: LocationSnapshot, ghostrail: GhostRailSegment[], keyframes: LocationKeyframe[], railVisible: boolean, buildings3d: boolean, reducedMotion: boolean, basemapMode: BasemapMode): MapRenderState {
  return {
    source,
    point: { lat: snapshot.lat, lng: snapshot.lng },
    accuracyM: snapshot.accuracyM,
    ghostrail,
    keyframes,
    motion: snapshot.motion,
    freshness: snapshot.freshness,
    health: snapshot.health,
    headingDeg: snapshot.headingDeg,
    railVisible,
    buildings3d,
    reducedMotion,
    basemapMode,
  }
}

function PublicAttribution({ mode }: { mode: BasemapMode }) {
  return (
    <div className="absolute bottom-[calc(max(8px,env(safe-area-inset-bottom))+88px)] left-2 z-[510] max-w-[calc(100vw-16px)] rounded-lg bg-black/80 px-2 py-1 text-[10px] leading-4 text-white/75 backdrop-blur-lg" aria-label="Atribución del mapa">
      {mode === 'vector-3d' ? <><a className="underline" href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a>{' © '}<a className="underline" href="https://openmaptiles.org" target="_blank" rel="noreferrer">OpenMapTiles</a>{' · Datos © '}<a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></> : <><a className="underline" href="https://cloudless.eox.at" target="_blank" rel="noreferrer">EOxCloudless</a>{' by EOX · Copernicus Sentinel 2016–2017'}{mode === 'hybrid' ? <>{' · '}<a className="underline" href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a>{' · Datos © '}<a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a></> : null}</>}
    </div>
  )
}

export default function MobileMapShell({ source, snapshot, ghostrail, keyframes = [], onChangeSource, onStop }: MobileMapShellProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const adapterRef = useRef<MapEngineAdapter | null>(null)
  const cameraRef = useRef<CameraControllerState>(initialCameraControllerState())
  const snapshotRef = useRef(snapshot)
  const reducedMotionRef = useRef(false)
  const recoveryRef = useRef(0)
  const [cameraMode, setCameraMode] = useState<CameraMode>('overview')
  const [basemapMode, setBasemapMode] = useState<BasemapMode>('vector-3d')
  const [basemapProviderState, setBasemapProviderState] = useState<BasemapProviderState>('idle')
  const [railVisible, setRailVisible] = useState(true)
  const [buildings3d, setBuildings3d] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [eventsOpen, setEventsOpen] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<LocationKeyframe | null>(null)
  const [contextRecovery, setContextRecovery] = useState(0)
  const [providerState, setProviderState] = useState<MapProviderState>('loading')
  const [performance, setPerformance] = useState<MapPerformanceSnapshot | null>(null)
  const reducedMotion = useReducedMotion()

  const currentRenderState = useMemo(() => renderState(source, snapshot, ghostrail, keyframes, railVisible, buildings3d, reducedMotion, basemapMode), [basemapMode, buildings3d, ghostrail, keyframes, railVisible, reducedMotion, snapshot, source])
  const renderStateRef = useRef(currentRenderState)

  useEffect(() => {
    snapshotRef.current = snapshot
    reducedMotionRef.current = reducedMotion
    recoveryRef.current = contextRecovery
    renderStateRef.current = currentRenderState
  }, [contextRecovery, currentRenderState, reducedMotion, snapshot])

  const applyCamera = useCallback((options: { userInteracted?: boolean; recenter?: boolean } = {}) => {
    const currentSnapshot = snapshotRef.current
    const plan = planCamera({
      current: cameraRef.current,
      motion: currentSnapshot.motion,
      hasPoint: true,
      userInteracted: options.userInteracted,
      recenter: options.recenter,
      measuredBearingDeg: currentSnapshot.headingDeg,
      reducedMotion: reducedMotionRef.current,
    })
    cameraRef.current = plan.state
    setCameraMode(plan.state.mode)
    adapterRef.current?.updateCamera({
      mode: plan.state.mode,
      center: { lat: currentSnapshot.lat, lng: currentSnapshot.lng },
      zoom: plan.zoom,
      pitchDeg: recoveryRef.current > 0 ? Math.min(plan.pitchDeg, recoveryRef.current === 1 ? 40 : 0) : plan.pitchDeg,
      bearingDeg: plan.state.bearingDeg,
      offsetYRatio: plan.offsetYRatio,
      durationMs: plan.durationMs,
      animate: plan.animate,
      shouldMove: plan.shouldMove,
    })
  }, [])

  const focusEvent = useCallback((event: LocationKeyframe) => {
    setSelectedEvent(event)
    setCameraMode('manual')
    adapterRef.current?.updateCamera({
      mode: 'manual',
      center: { lat: event.lat, lng: event.lng },
      zoom: 16,
      pitchDeg: basemapMode === 'vector-3d' ? 52 : 20,
      bearingDeg: null,
      offsetYRatio: 0.12,
      durationMs: reducedMotionRef.current ? 0 : 500,
      animate: !reducedMotionRef.current,
      shouldMove: true,
    })
  }, [basemapMode])

  const enterManualMode = useCallback(() => {
    const currentSnapshot = snapshotRef.current
    const plan = planCamera({ current: cameraRef.current, motion: currentSnapshot.motion, hasPoint: true, userInteracted: true, measuredBearingDeg: currentSnapshot.headingDeg, reducedMotion: reducedMotionRef.current })
    cameraRef.current = plan.state
    setCameraMode('manual')
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    const adapter = createMapLibreAdapter()
    adapterRef.current = adapter
    setProviderState('loading')
    setBasemapProviderState('idle')
    adapter.mount(containerRef.current, renderStateRef.current, {
      onManualInteraction: enterManualMode,
      onWebglContextLost: () => { setContextRecovery((value) => Math.min(4, value + 1)); setBuildings3d(false) },
      onWebglContextRestored: () => setContextRecovery((value) => Math.min(4, value + 1)),
      onProviderState: setProviderState,
      onBasemapProviderState: setBasemapProviderState,
      onPerformance: setPerformance,
    })
    applyCamera({ recenter: true })
    return () => { adapter.destroy(); adapterRef.current = null; cameraRef.current = initialCameraControllerState() }
  }, [applyCamera, enterManualMode, source])

  useEffect(() => { adapterRef.current?.render(currentRenderState) }, [currentRenderState])
  useEffect(() => { applyCamera() }, [applyCamera, contextRecovery, reducedMotion, snapshot])
  useEffect(() => {
    const resize = () => adapterRef.current?.resize()
    const visibility = () => { if (document.visibilityState === 'visible') resize() }
    window.addEventListener('orientationchange', resize)
    window.addEventListener('resize', resize)
    document.addEventListener('visibilitychange', visibility)
    return () => { window.removeEventListener('orientationchange', resize); window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', visibility) }
  }, [])

  const sourceTitle = source === 'my-device' ? 'MI UBICACIÓN' : 'UBICACIÓN COMPARTIDA · STRACKER'
  const stateText = snapshot.health === 'receiving' ? 'RECIBIENDO' : snapshot.health === 'degraded' ? 'DEGRADADA' : snapshot.health === 'unreachable' ? 'INALCANZABLE' : 'DESCONOCIDA'
  const ghostrailPointCount = ghostrail.reduce((total, segment) => total + segment.points.length, 0)
  const observedSegments = ghostrail.filter((segment) => (segment.provenance || 'observed') === 'observed').length
  const inferredSegments = ghostrail.filter((segment) => segment.provenance === 'inferred').length
  const satelliteUnavailable = basemapMode !== 'vector-3d' && basemapProviderState === 'unavailable'

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden bg-black text-white" data-location-source={source} data-map-engine="maplibre" data-map-provider={providerState} data-basemap-mode={basemapMode} data-basemap-provider={basemapProviderState} data-camera-mode={cameraMode} data-camera-animation={reducedMotion ? 'off' : 'on'} data-reduced-motion={reducedMotion ? 'true' : 'false'} data-motion={snapshot.motion} data-freshness={snapshot.freshness} data-health={snapshot.health} data-filter-decision={snapshot.filterDecision} data-marker-present="true" data-captured-at={snapshot.capturedAt} data-ghostrail-segments={ghostrail.length} data-ghostrail-observed={observedSegments} data-ghostrail-inferred={inferredSegments} data-ghostrail-points={ghostrailPointCount} data-keyframes={keyframes.length} data-webgl-recovery={contextRecovery} data-map-first-visible-ms={performance?.firstMapVisibleMs ?? ''} data-map-first-interactive-ms={performance?.firstInteractiveMs ?? ''} data-map-fps={performance?.estimatedFps ?? ''} data-map-long-tasks={performance?.longTasks ?? ''} data-map-long-task-ms={performance?.longTaskDurationMs ?? ''} data-map-transferred-bytes={performance?.transferredBytes ?? ''} data-raster-request-count={performance?.rasterResourceCount ?? 0} data-raster-transferred-bytes={performance?.rasterTransferredBytes ?? 0}>
      <div ref={containerRef} className="h-full w-full" aria-label="Mapa de ubicación" />
      {providerState === 'degraded' ? <div role="status" className="absolute inset-x-3 top-[calc(max(12px,env(safe-area-inset-top))+112px)] z-[520] rounded-2xl border border-white/15 bg-black/90 px-4 py-3 text-center text-xs text-white/80 backdrop-blur-xl">MAPA DEGRADADO · LOS DATOS DE UBICACIÓN SIGUEN AISLADOS</div> : null}
      {satelliteUnavailable ? <div role="alert" className="absolute inset-x-3 top-[calc(max(12px,env(safe-area-inset-top))+112px)] z-[525] rounded-2xl border border-white/20 bg-black/95 px-4 py-3 text-center text-xs font-semibold text-white backdrop-blur-xl">SATÉLITE NO DISPONIBLE EN ESTA ZONA</div> : null}
      {selectedEvent ? <div role="status" data-event-popup className="absolute left-3 top-[calc(max(12px,env(safe-area-inset-top))+116px)] z-[530] max-w-[calc(100vw-84px)] rounded-2xl border border-white/15 bg-black/90 px-3 py-2 text-xs shadow-xl backdrop-blur-xl"><p className="font-semibold">{EVENT_LABELS[selectedEvent.type]}</p><p className="mt-1 text-white/55">{new Date(selectedEvent.at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })} · {selectedEvent.provenance === 'observed' ? 'OBSERVADO' : `INFERIDO · ${selectedEvent.confidence.toUpperCase()}`}</p></div> : null}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-[500] flex justify-center px-3 pt-[max(12px,env(safe-area-inset-top))]"><div className="max-w-[calc(100vw-24px)] truncate rounded-full border border-white/10 bg-black/85 px-4 py-2 text-sm font-semibold shadow-lg backdrop-blur-xl">{sourceTitle} · {freshnessText(snapshot)}</div></div>
      <div className={`absolute right-[64px] top-[calc(max(12px,env(safe-area-inset-top))+58px)] z-[505] grid grid-cols-3 overflow-hidden rounded-xl border border-white/10 bg-black/90 backdrop-blur-xl ${expanded ? 'left-[64px]' : 'left-3'}`} aria-label="Modo cartográfico">
        {BASEMAP_MODES.map((mode) => <button key={mode} type="button" aria-pressed={basemapMode === mode} onClick={() => setBasemapMode(mode)} className={`min-h-11 px-1 text-[10px] font-semibold tracking-[0.03em] ${basemapMode === mode ? 'bg-white text-black' : 'text-white/70'}`}>{basemapLabel(mode)}</button>)}
      </div>
      <div className="absolute right-3 top-[calc(max(12px,env(safe-area-inset-top))+58px)] z-[500] flex flex-col gap-2">
        <button type="button" aria-label="Activar o desactivar edificios 3D" aria-pressed={buildings3d} disabled={basemapMode !== 'vector-3d'} onClick={() => setBuildings3d((value) => !value)} className="grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-black/85 backdrop-blur-xl active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"><Building2 size={20} /></button>
        <button type="button" aria-label="Recentrar mapa" onClick={() => { setSelectedEvent(null); applyCamera({ recenter: true }) }} className="grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-black/85 backdrop-blur-xl active:scale-95"><LocateFixed size={20} /></button>
        <button type="button" aria-label="Mostrar u ocultar GhostRail" aria-pressed={railVisible} onClick={() => setRailVisible((value) => !value)} className="grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-black/85 backdrop-blur-xl active:scale-95"><Route size={20} /></button>
        {keyframes.length ? <button type="button" aria-label="Eventos 24 horas" aria-pressed={eventsOpen} onClick={() => setEventsOpen((value) => !value)} className="grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-black/85 backdrop-blur-xl active:scale-95"><Clock3 size={20} /></button> : null}
      </div>
      {railVisible && ghostrail.length ? <div className="absolute left-3 top-[calc(max(12px,env(safe-area-inset-top))+114px)] z-[500] rounded-xl border border-white/10 bg-black/80 px-2 py-1 text-[10px] text-white/65"><span className="font-semibold">— OBSERVADO</span>{inferredSegments ? <span className="ml-3">- - INFERIDO</span> : null}</div> : null}
      {eventsOpen && keyframes.length ? <aside data-events-24h className="absolute bottom-[calc(max(8px,env(safe-area-inset-bottom))+92px)] right-2 z-[540] max-h-[48dvh] w-[min(330px,calc(100vw-16px))] overflow-y-auto rounded-[22px] border border-white/10 bg-black/95 p-3 shadow-2xl backdrop-blur-2xl"><div className="flex items-center justify-between"><div><p className="text-xs font-semibold tracking-[0.14em] text-white/55">EVENTOS 24H</p><p className="mt-1 text-sm font-semibold">{keyframes.length} keyframes</p></div><button type="button" aria-label="Cerrar eventos" onClick={() => setEventsOpen(false)} className="grid h-10 w-10 place-items-center rounded-full border border-white/10"><X size={17} /></button></div><div className="mt-3 grid gap-2">{[...keyframes].reverse().map((event) => <button key={event.id} type="button" onClick={() => focusEvent(event)} className="rounded-2xl border border-white/8 bg-white/[0.035] p-3 text-left"><p className="text-xs font-semibold">{EVENT_LABELS[event.type]}</p><p className="mt-1 text-[11px] text-white/50">{new Date(event.at).toLocaleString('es-AR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })} · {event.provenance === 'observed' ? 'OBSERVADO' : `INFERIDO ${event.confidence.toUpperCase()}`}</p></button>)}</div></aside> : null}
      <PublicAttribution mode={basemapMode} />
      <section className="absolute inset-x-2 bottom-[max(8px,env(safe-area-inset-bottom))] z-[500] rounded-[24px] border border-white/10 bg-black/90 shadow-2xl backdrop-blur-2xl" aria-label="Estado de ubicación">
        <button type="button" onClick={() => setExpanded((value) => !value)} className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left" aria-expanded={expanded}><div className="min-w-0"><p className="truncate text-[11px] font-semibold tracking-[0.14em] text-white/55">{sourceTitle}</p><p className="truncate text-base font-semibold">{cameraMode.toUpperCase()} · {basemapLabel(basemapMode)}</p></div><div className="grid grid-cols-2 gap-x-4 gap-y-1 text-right text-xs"><span className="text-white/45">PRECISIÓN</span><span>{snapshot.accuracyM ? `${Math.round(snapshot.accuracyM)} m` : '—'}</span><span className="text-white/45">ESTADO</span><span>{stateText}</span></div></button>
        {expanded ? <div className="max-h-[46dvh] overflow-y-auto border-t border-white/10 px-4 pb-4 pt-3">
          <div className="grid grid-cols-2 gap-2 text-xs"><div className="rounded-2xl bg-white/[0.04] p-3"><p className="text-white/45">ACTUALIZACIÓN</p><p className="mt-1 font-medium">{freshnessText(snapshot)}</p></div><div className="rounded-2xl bg-white/[0.04] p-3"><p className="text-white/45">PRECISIÓN</p><p className="mt-1 font-medium">{snapshot.accuracyM ? `${Math.round(snapshot.accuracyM)} m` : '—'}</p></div><div className="rounded-2xl bg-white/[0.04] p-3"><p className="text-white/45">ESTADO</p><p className="mt-1 font-medium">{stateText}</p></div><div className="rounded-2xl bg-white/[0.04] p-3"><p className="text-white/45">MOVIMIENTO</p><p className="mt-1 font-medium">{snapshot.motion.toUpperCase()}</p></div><div className="col-span-2 rounded-2xl bg-white/[0.04] p-3"><p className="text-white/45">GHOSTRAIL 24H</p><p className="mt-1 font-medium">{observedSegments} observado · {inferredSegments} inferido · {keyframes.length} eventos</p></div></div>
          <p className="mt-3 text-[10px] leading-4 text-white/35">Los proveedores cartográficos reciben solicitudes de estilo o tiles del viewport. Los tramos inferidos se presentan como hipótesis visuales y nunca como historia observada.</p>
          {basemapMode !== 'vector-3d' ? <p className="mt-2 text-[10px] leading-4 text-white/35">SATÉLITE: {SATELLITE_PROVIDER.imageryPeriod}, resolución nominal {SATELLITE_PROVIDER.resolutionMeters} m. No se presenta como imagen reciente.</p> : null}
          {performance ? <p className="mt-2 text-[10px] text-white/30" data-performance-summary>MAPLIBRE · {performance.firstInteractiveMs ? `${Math.round(performance.firstInteractiveMs)}ms` : 'cargando'} · {performance.estimatedFps ?? '—'} FPS · RASTER {performance.rasterResourceCount} req / {performance.rasterTransferredBytes} B</p> : null}
          <div className="mt-3 grid gap-2">{onStop ? <button type="button" onClick={onStop} className="min-h-11 rounded-2xl border border-white/15 px-4 text-sm font-semibold">{source === 'my-device' ? 'Detener seguimiento' : 'Cerrar ubicación'}</button> : null}<button type="button" onClick={onChangeSource} className="min-h-11 rounded-2xl border border-white/15 px-4 text-sm font-semibold">Cambiar ubicación</button></div>
        </div> : null}
      </section>
      {expanded ? <button type="button" aria-label="Cerrar panel" onClick={() => setExpanded(false)} className="absolute left-3 top-[calc(max(12px,env(safe-area-inset-top))+58px)] z-[510] grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-black/85 backdrop-blur-xl"><X size={20} /></button> : null}
    </main>
  )
}
