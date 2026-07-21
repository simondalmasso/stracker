'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Building2, LocateFixed, Route, X } from 'lucide-react'
import type {
  CameraMode,
  GhostRailSegment,
  LocationSnapshot,
  LocationSource,
  SharedSessionState,
} from '@/lib/location-source/contracts'
import { initialCameraControllerState, planCamera, type CameraControllerState } from '@/lib/location-source/camera-controller'
import { createMapLibreAdapter } from '@/lib/location-source/map-engine/maplibre-adapter'
import type { MapEngineAdapter, MapPerformanceSnapshot, MapRenderState } from '@/lib/location-source/map-engine/contracts'

interface MobileMapShellProps {
  source: LocationSource
  snapshot: LocationSnapshot
  ghostrail: GhostRailSegment[]
  sharedSessionState: SharedSessionState
  onChangeSource: () => void
  onStop?: () => void
  onReplaceSession?: () => void
  onDeleteSession?: () => void
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

function renderState(
  source: LocationSource,
  snapshot: LocationSnapshot,
  ghostrail: GhostRailSegment[],
  railVisible: boolean,
  buildings3d: boolean,
  reducedMotion: boolean,
): MapRenderState {
  return {
    source,
    point: { lat: snapshot.lat, lng: snapshot.lng },
    accuracyM: snapshot.accuracyM,
    ghostrail,
    motion: snapshot.motion,
    freshness: snapshot.freshness,
    health: snapshot.health,
    headingDeg: snapshot.headingDeg,
    railVisible,
    buildings3d,
    reducedMotion,
  }
}

function PublicAttribution() {
  return (
    <div className="absolute bottom-[calc(max(8px,env(safe-area-inset-bottom))+88px)] left-2 z-[510] max-w-[calc(100vw-16px)] rounded-lg bg-black/80 px-2 py-1 text-[10px] leading-4 text-white/70 backdrop-blur-lg" aria-label="Atribución del mapa">
      <a className="underline" href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a>
      {' © '}
      <a className="underline" href="https://openmaptiles.org" target="_blank" rel="noreferrer">OpenMapTiles</a>
      {' · Datos © '}
      <a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>
    </div>
  )
}

export default function MobileMapShell({
  source,
  snapshot,
  ghostrail,
  sharedSessionState,
  onChangeSource,
  onStop,
  onReplaceSession,
  onDeleteSession,
}: MobileMapShellProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const adapterRef = useRef<MapEngineAdapter | null>(null)
  const cameraRef = useRef<CameraControllerState>(initialCameraControllerState())
  const [cameraMode, setCameraMode] = useState<CameraMode>('overview')
  const [railVisible, setRailVisible] = useState(true)
  const [buildings3d, setBuildings3d] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [contextRecovery, setContextRecovery] = useState(0)
  const [performance, setPerformance] = useState<MapPerformanceSnapshot | null>(null)
  const reducedMotion = useReducedMotion()

  const currentRenderState = useMemo(
    () => renderState(source, snapshot, ghostrail, railVisible, buildings3d, reducedMotion),
    [buildings3d, ghostrail, railVisible, reducedMotion, snapshot, source],
  )

  const applyCamera = useCallback((options: { userInteracted?: boolean; recenter?: boolean } = {}) => {
    const plan = planCamera({
      current: cameraRef.current,
      motion: snapshot.motion,
      hasPoint: true,
      userInteracted: options.userInteracted,
      recenter: options.recenter,
      measuredBearingDeg: snapshot.headingDeg,
      reducedMotion,
    })
    cameraRef.current = plan.state
    setCameraMode(plan.state.mode)
    adapterRef.current?.updateCamera({
      mode: plan.state.mode,
      center: { lat: snapshot.lat, lng: snapshot.lng },
      zoom: plan.zoom,
      pitchDeg: contextRecovery > 0 ? Math.min(plan.pitchDeg, contextRecovery === 1 ? 40 : 0) : plan.pitchDeg,
      bearingDeg: plan.state.bearingDeg,
      offsetYRatio: plan.offsetYRatio,
      durationMs: plan.durationMs,
      animate: plan.animate,
      shouldMove: plan.shouldMove,
    })
  }, [contextRecovery, reducedMotion, snapshot])

  useEffect(() => {
    if (!containerRef.current) return
    const adapter = createMapLibreAdapter()
    adapterRef.current = adapter
    adapter.mount(containerRef.current, currentRenderState, {
      onManualInteraction: () => applyCamera({ userInteracted: true }),
      onWebglContextLost: () => {
        setContextRecovery((value) => Math.min(4, value + 1))
        setBuildings3d(false)
      },
      onWebglContextRestored: () => {
        setContextRecovery((value) => Math.min(4, value + 1))
      },
      onPerformance: setPerformance,
    })
    applyCamera({ recenter: true })
    return () => {
      adapter.destroy()
      adapterRef.current = null
    }
  // The adapter is intentionally mounted once per selected source.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  useEffect(() => {
    adapterRef.current?.render(currentRenderState)
    applyCamera()
  }, [applyCamera, currentRenderState])

  useEffect(() => {
    const resize = () => adapterRef.current?.resize()
    const visibility = () => {
      if (document.visibilityState === 'visible') resize()
    }
    window.addEventListener('orientationchange', resize)
    window.addEventListener('resize', resize)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('orientationchange', resize)
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])

  const sourceTitle = source === 'my-device' ? 'MI UBICACIÓN' : 'UBICACIÓN COMPARTIDA'
  const stateText = snapshot.health === 'receiving'
    ? 'RECIBIENDO'
    : snapshot.health === 'degraded'
      ? 'DEGRADADA'
      : snapshot.health === 'unreachable'
        ? 'INALCANZABLE'
        : 'DESCONOCIDA'

  return (
    <main
      className="relative h-[100dvh] w-full overflow-hidden bg-black text-white"
      data-location-source={source}
      data-map-engine="maplibre"
      data-camera-mode={cameraMode}
      data-webgl-recovery={contextRecovery}
    >
      <div ref={containerRef} className="h-full w-full" aria-label="Mapa vectorial de ubicación" />

      <div className="pointer-events-none absolute inset-x-0 top-0 z-[500] flex justify-center px-3 pt-[max(12px,env(safe-area-inset-top))]">
        <div className="max-w-[calc(100vw-24px)] truncate rounded-full border border-white/10 bg-black/85 px-4 py-2 text-sm font-semibold shadow-lg backdrop-blur-xl">
          {sourceTitle} · {freshnessText(snapshot)}
        </div>
      </div>

      <div className="absolute right-3 top-[calc(max(12px,env(safe-area-inset-top))+58px)] z-[500] flex flex-col gap-2">
        <button type="button" aria-label="Activar o desactivar edificios 3D" aria-pressed={buildings3d} onClick={() => setBuildings3d((value) => !value)} className="grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-black/85 backdrop-blur-xl active:scale-95"><Building2 size={20} /></button>
        <button type="button" aria-label="Recentrar mapa" onClick={() => applyCamera({ recenter: true })} className="grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-black/85 backdrop-blur-xl active:scale-95"><LocateFixed size={20} /></button>
        <button type="button" aria-label="Mostrar u ocultar GhostRail" aria-pressed={railVisible} onClick={() => setRailVisible((value) => !value)} className="grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-black/85 backdrop-blur-xl active:scale-95"><Route size={20} /></button>
      </div>

      <PublicAttribution />

      <section className="absolute inset-x-2 bottom-[max(8px,env(safe-area-inset-bottom))] z-[500] rounded-[24px] border border-white/10 bg-black/90 shadow-2xl backdrop-blur-2xl" aria-label="Estado de ubicación">
        <button type="button" onClick={() => setExpanded((value) => !value)} className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left" aria-expanded={expanded}>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold tracking-[0.14em] text-white/55">{sourceTitle}</p>
            <p className="truncate text-base font-semibold">{cameraMode.toUpperCase()}</p>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-right text-xs">
            <span className="text-white/45">PRECISIÓN</span><span>{snapshot.accuracyM ? `${Math.round(snapshot.accuracyM)} m` : '—'}</span>
            <span className="text-white/45">ESTADO</span><span>{stateText}</span>
          </div>
        </button>

        {expanded ? (
          <div className="max-h-[46dvh] overflow-y-auto border-t border-white/10 px-4 pb-4 pt-3">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-2xl bg-white/[0.04] p-3"><p className="text-white/45">ACTUALIZACIÓN</p><p className="mt-1 font-medium">{freshnessText(snapshot)}</p></div>
              <div className="rounded-2xl bg-white/[0.04] p-3"><p className="text-white/45">MOVIMIENTO</p><p className="mt-1 font-medium">{snapshot.motion.toUpperCase()}</p></div>
              <div className="rounded-2xl bg-white/[0.04] p-3"><p className="text-white/45">FUENTE</p><p className="mt-1 font-medium">{sourceTitle}</p></div>
              <div className="rounded-2xl bg-white/[0.04] p-3"><p className="text-white/45">SESIÓN</p><p className="mt-1 font-medium">{sharedSessionState.toUpperCase()}</p></div>
            </div>
            <p className="mt-3 text-[10px] leading-4 text-white/35">El proveedor de mapas recibe solicitudes de estilo y tiles correspondientes al viewport. Las coordenadas de MI UBICACIÓN no se envían al backend compartido.</p>
            {performance ? <p className="mt-2 text-[10px] text-white/30" data-performance-summary>MAPLIBRE · {performance.firstInteractiveMs ? `${Math.round(performance.firstInteractiveMs)}ms` : 'cargando'} · {performance.estimatedFps ?? '—'} FPS</p> : null}
            <div className="mt-3 grid gap-2">
              {source === 'google-shared' && onReplaceSession ? <button type="button" onClick={onReplaceSession} className="min-h-11 rounded-2xl bg-white px-4 text-sm font-semibold text-black">Reemplazar sesión</button> : null}
              {source === 'google-shared' && onDeleteSession ? <button type="button" onClick={onDeleteSession} className="min-h-11 rounded-2xl border border-white/15 px-4 text-sm font-semibold">Eliminar sesión</button> : null}
              {source === 'my-device' && onStop ? <button type="button" onClick={onStop} className="min-h-11 rounded-2xl border border-white/15 px-4 text-sm font-semibold">Detener seguimiento</button> : null}
              <button type="button" onClick={onChangeSource} className="min-h-11 rounded-2xl border border-white/15 px-4 text-sm font-semibold">Cambiar ubicación</button>
            </div>
          </div>
        ) : null}
      </section>

      {expanded ? <button type="button" aria-label="Cerrar panel" onClick={() => setExpanded(false)} className="absolute left-3 top-[calc(max(12px,env(safe-area-inset-top))+58px)] z-[500] grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-black/85 backdrop-blur-xl"><X size={20} /></button> : null}
    </main>
  )
}
