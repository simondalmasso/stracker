'use client'

import { useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { Layers, LocateFixed, Route, X } from 'lucide-react'
import type { LocationSnapshot, LocationSource } from '@/lib/location-source/contracts'

const MobileAtlasCanvas = dynamic(() => import('./MobileAtlasCanvas'), { ssr: false })

interface MobileMapShellProps {
  source: LocationSource
  snapshot: LocationSnapshot
  ghostrail: LocationSnapshot[]
  trackingLabel: string
  sessionLabel: string
  onChangeSource: () => void
  onStop?: () => void
  onReplaceSession?: () => void
  onDeleteSession?: () => void
}

function freshnessText(snapshot: LocationSnapshot): string {
  if (snapshot.freshness === 'fresh') {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(snapshot.capturedAt)) / 1000))
    return seconds < 5 ? 'ACTIVA' : `hace ${seconds}s`
  }
  const minutes = Math.max(1, Math.round((Date.now() - Date.parse(snapshot.capturedAt)) / 60_000))
  return snapshot.freshness === 'stale' ? `hace ${minutes}min` : 'SIN ACTUALIZACIÓN'
}

export default function MobileMapShell({
  source,
  snapshot,
  ghostrail,
  trackingLabel,
  sessionLabel,
  onChangeSource,
  onStop,
  onReplaceSession,
  onDeleteSession,
}: MobileMapShellProps) {
  const [satellite, setSatellite] = useState(false)
  const [railVisible, setRailVisible] = useState(source === 'google-shared')
  const [expanded, setExpanded] = useState(false)
  const [centerRequest, setCenterRequest] = useState(0)

  const rail = useMemo(
    () =>
      ghostrail
        .filter((point) => point.source === source)
        .map((point) => [point.lat, point.lng] as [number, number]),
    [ghostrail, source],
  )

  const sourceTitle = source === 'my-device' ? 'MI UBICACIÓN' : 'UBICACIÓN COMPARTIDA'
  const positionTitle = source === 'my-device' ? 'Vos' : 'Ubicación compartida'

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden bg-black text-white" data-location-source={source}>
      <MobileAtlasCanvas
        snapshot={snapshot}
        ghostrail={ghostrail}
        satellite={satellite}
        railVisible={railVisible && rail.length > 1}
        centerRequest={centerRequest}
      />

      <div className="pointer-events-none absolute left-3 top-[calc(max(12px,env(safe-area-inset-top))+58px)] z-[500] rounded-full border border-white/10 bg-black/75 px-3 py-2 text-[10px] font-semibold tracking-[0.14em] text-white/80 backdrop-blur-xl">
        {satellite ? 'SATÉLITE' : 'ATLAS ISOMÉTRICO 2.5D'}
      </div>
      <div className="pointer-events-none absolute bottom-[calc(max(8px,env(safe-area-inset-bottom))+88px)] left-3 z-[500] rounded-full bg-black/70 px-2 py-1 text-[9px] text-white/65">
        © OpenFreeMap · OpenStreetMap{satellite ? ' · Esri' : ''}
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 z-[500] flex justify-center px-3 pt-[max(12px,env(safe-area-inset-top))]">
        <div className="max-w-[calc(100vw-24px)] truncate rounded-full border border-white/10 bg-black/85 px-4 py-2 text-sm font-semibold shadow-lg backdrop-blur-xl">
          {positionTitle} · {freshnessText(snapshot)}
        </div>
      </div>

      <div className="absolute right-3 top-[calc(max(12px,env(safe-area-inset-top))+58px)] z-[500] flex flex-col gap-2">
        <button
          type="button"
          aria-label={satellite ? "Volver al atlas 3D" : "Activar vista satélite"}
          onClick={() => setSatellite((value) => !value)}
          className="grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-black/85 backdrop-blur-xl active:scale-95"
        >
          <Layers size={20} />
        </button>
        <button
          type="button"
          aria-label="Centrar mapa"
          onClick={() => setCenterRequest((value) => value + 1)}
          className="grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-black/85 backdrop-blur-xl active:scale-95"
        >
          <LocateFixed size={20} />
        </button>
        <button
          type="button"
          aria-label="Mostrar u ocultar rastro"
          onClick={() => setRailVisible((value) => !value)}
          className="grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-black/85 backdrop-blur-xl active:scale-95"
        >
          <Route size={20} />
        </button>
      </div>

      <section
        className="absolute inset-x-2 bottom-[max(8px,env(safe-area-inset-bottom))] z-[500] rounded-[24px] border border-white/10 bg-black/90 shadow-2xl backdrop-blur-2xl"
        aria-label="Estado de ubicación"
      >
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left"
          aria-expanded={expanded}
        >
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold tracking-[0.14em] text-white/55">{sourceTitle}</p>
            <p className="truncate text-base font-semibold">{positionTitle}</p>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-right text-xs">
            <span className="text-white/45">Precisión</span>
            <span>{snapshot.accuracyM ? `${Math.round(snapshot.accuracyM)} m` : '—'}</span>
            <span className="text-white/45">Estado</span>
            <span>{trackingLabel}</span>
          </div>
        </button>

        {expanded ? (
          <div className="max-h-[46dvh] overflow-y-auto border-t border-white/10 px-4 pb-4 pt-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-2xl bg-white/[0.04] p-3">
                <p className="text-xs text-white/45">Última lectura</p>
                <p className="mt-1 font-medium">{new Date(snapshot.capturedAt).toLocaleTimeString()}</p>
              </div>
              <div className="rounded-2xl bg-white/[0.04] p-3">
                <p className="text-xs text-white/45">Sesión</p>
                <p className="mt-1 font-medium">{sessionLabel}</p>
              </div>
            </div>
            <div className="mt-3 grid gap-2">
              {source === 'google-shared' && onReplaceSession ? (
                <button type="button" onClick={onReplaceSession} className="min-h-11 rounded-2xl bg-white px-4 text-sm font-semibold text-black">
                  Reemplazar sesión
                </button>
              ) : null}
              {source === 'google-shared' && onDeleteSession ? (
                <button type="button" onClick={onDeleteSession} className="min-h-11 rounded-2xl border border-white/15 px-4 text-sm font-semibold">
                  Eliminar sesión
                </button>
              ) : null}
              {source === 'my-device' && onStop ? (
                <button type="button" onClick={onStop} className="min-h-11 rounded-2xl border border-white/15 px-4 text-sm font-semibold">
                  Detener seguimiento
                </button>
              ) : null}
              <button type="button" onClick={onChangeSource} className="min-h-11 rounded-2xl border border-white/15 px-4 text-sm font-semibold">
                Cambiar ubicación
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {expanded ? (
        <button
          type="button"
          aria-label="Cerrar panel"
          onClick={() => setExpanded(false)}
          className="absolute left-3 top-[calc(max(12px,env(safe-area-inset-top))+58px)] z-[500] grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-black/85 backdrop-blur-xl"
        >
          <X size={20} />
        </button>
      ) : null}
    </main>
  )
}
