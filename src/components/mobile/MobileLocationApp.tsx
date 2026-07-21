'use client'

import { useCallback, useEffect, useState } from 'react'
import { Crosshair, MapPinned, ShieldCheck, Smartphone } from 'lucide-react'
import type { LocationSource, ProductFlow } from '@/lib/location-source/contracts'
import { useMyLocation } from '@/lib/location-source/use-my-location'
import { useSharedLocation } from '@/lib/location-source/use-shared-location'
import { MobileMapShell } from './MobileMapShell'

const SOURCE_KEY = 'stracker:lastSelectedSource'

function SourceSelector({ onSelect }: { onSelect: (source: LocationSource) => void }) {
  return (
    <main className="min-h-[100dvh] overflow-x-hidden bg-black px-4 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(28px,env(safe-area-inset-top))] text-white">
      <div className="mx-auto flex min-h-[calc(100dvh-56px)] w-full max-w-md flex-col justify-center">
        <p className="text-xs font-semibold tracking-[0.28em] text-white/45">STRACKER</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">¿Qué ubicación querés ver?</h1>
        <p className="mt-3 max-w-sm text-sm leading-6 text-white/55">Elegí una fuente. No se solicitan permisos ni sesiones hasta que selecciones una opción.</p>

        <div className="mt-8 grid gap-3">
          <button type="button" onClick={() => onSelect('my-device')} className="min-h-24 rounded-3xl border border-white/12 bg-white/[0.04] p-5 text-left active:bg-white/[0.08]">
            <span className="flex items-center gap-3 text-sm font-semibold"><Smartphone size={22} /> MI UBICACIÓN</span>
            <span className="mt-2 block text-sm leading-5 text-white/50">Usar la ubicación de este teléfono.</span>
          </button>
          <button type="button" onClick={() => onSelect('google-shared')} className="min-h-24 rounded-3xl border border-white/12 bg-white/[0.04] p-5 text-left active:bg-white/[0.08]">
            <span className="flex items-center gap-3 text-sm font-semibold"><MapPinned size={22} /> UBICACIÓN COMPARTIDA</span>
            <span className="mt-2 block text-sm leading-5 text-white/50">Ver una ubicación que alguien comparte conmigo en Google Maps.</span>
          </button>
        </div>

        <p className="mt-6 text-center text-xs leading-5 text-white/35">Podés cambiar de modo más adelante.</p>
        <p className="mt-3 text-center text-[11px] leading-5 text-white/30">STRACKER sólo debe usarse con ubicaciones propias o compartidas voluntariamente con tu cuenta.</p>
      </div>
    </main>
  )
}

function MyLocationPermission({ request, state, onBack }: { request: () => void; state: string; onBack: () => void }) {
  return (
    <main className="min-h-[100dvh] overflow-x-hidden bg-black px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(24px,env(safe-area-inset-top))] text-white">
      <div className="mx-auto flex min-h-[calc(100dvh-48px)] max-w-md flex-col justify-center">
        <Crosshair size={30} />
        <h1 className="mt-5 text-2xl font-semibold">Tu ubicación</h1>
        <p className="mt-3 text-sm leading-6 text-white/55">STRACKER necesita permiso para mostrar tu ubicación actual. La ubicación se usa únicamente dentro del mapa.</p>
        {state !== 'MY_LOCATION_IDLE' ? <p className="mt-4 text-sm text-white/60">Estado: {state}</p> : null}
        <button type="button" onClick={request} className="mt-8 min-h-12 rounded-2xl bg-white px-5 text-sm font-semibold text-black">PERMITIR UBICACIÓN</button>
        <button type="button" onClick={onBack} className="mt-3 min-h-11 rounded-2xl border border-white/10 text-sm text-white/60">VOLVER</button>
      </div>
    </main>
  )
}

function SharedOnboarding({ onImport, onBack, status, loading }: { onImport: () => void; onBack: () => void; status: string; loading: boolean }) {
  return (
    <main className="min-h-[100dvh] overflow-x-hidden bg-black px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(24px,env(safe-area-inset-top))] text-white">
      <div className="mx-auto flex min-h-[calc(100dvh-48px)] max-w-md flex-col justify-center">
        <ShieldCheck size={30} />
        <h1 className="mt-5 text-2xl font-semibold">Ubicación compartida</h1>
        <p className="mt-3 text-sm leading-6 text-white/55">Vinculá una sesión autorizada de Google Maps para ver una ubicación que ya comparten con vos.</p>
        <p className="mt-4 text-sm text-white/45">Estado: {loading ? 'VALIDANDO' : status}</p>
        <button type="button" onClick={onImport} className="mt-8 min-h-12 rounded-2xl bg-white px-5 text-sm font-semibold text-black">VINCULAR SESIÓN</button>
        <button type="button" onClick={onBack} className="mt-3 min-h-11 rounded-2xl border border-white/10 text-sm text-white/60">VOLVER</button>
      </div>
    </main>
  )
}

function SharedImporter({ onCancel, onSuccess }: { onCancel: () => void; onSuccess: () => void }) {
  const shared = useSharedLocation()
  const [raw, setRaw] = useState('')
  const [message, setMessage] = useState('Pegá una exportación autorizada de Google Maps.')

  const submit = async () => {
    const result = await shared.importSession(raw)
    setMessage(result.message || result.error || 'No se pudo validar la sesión.')
    if (result.configured) onSuccess()
  }

  return (
    <main className="min-h-[100dvh] overflow-x-hidden bg-black px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-[max(16px,env(safe-area-inset-top))] text-white">
      <div className="mx-auto w-full max-w-md">
        <h1 className="text-xl font-semibold">Importar sesión autorizada</h1>
        <p className="mt-2 text-xs leading-5 text-white/45">Cookie Editor JSON, JSON envuelto, Header String o Netscape. Nunca se muestran valores.</p>
        <textarea value={raw} onChange={(event) => setRaw(event.target.value)} className="mt-4 min-h-[45dvh] w-full resize-none rounded-2xl border border-white/12 bg-white/[0.04] p-4 text-sm outline-none" placeholder="Pegá la sesión acá" />
        <p className="mt-3 text-xs leading-5 text-white/50">{message}</p>
        <button type="button" disabled={!raw.trim()} onClick={submit} className="mt-4 min-h-12 w-full rounded-2xl bg-white text-sm font-semibold text-black disabled:opacity-40">IMPORTAR Y VALIDAR</button>
        <button type="button" onClick={onCancel} className="mt-3 min-h-11 w-full rounded-2xl border border-white/10 text-sm text-white/60">CANCELAR</button>
      </div>
    </main>
  )
}

export default function MobileLocationApp() {
  const [flow, setFlow] = useState<ProductFlow>('SELECTING_SOURCE')
  const [source, setSource] = useState<LocationSource | null>(null)
  const [showSharedImporter, setShowSharedImporter] = useState(false)
  const myLocation = useMyLocation()
  const shared = useSharedLocation()

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = window.localStorage.getItem(SOURCE_KEY)
      if (stored === 'my-device' || stored === 'google-shared') setSource(stored)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  const selectSource = useCallback((next: LocationSource) => {
    myLocation.stop()
    shared.stop()
    setSource(next)
    window.localStorage.setItem(SOURCE_KEY, next)
    if (next === 'my-device') setFlow('MY_LOCATION_FLOW')
    else {
      setFlow('SHARED_LOCATION_FLOW')
      setShowSharedImporter(false)
      void shared.refreshStatus()
    }
  }, [myLocation, shared])

  const returnToSelector = useCallback(() => {
    myLocation.stop()
    shared.stop()
    setFlow('SELECTING_SOURCE')
    setSource(null)
    setShowSharedImporter(false)
  }, [myLocation, shared])

  if (flow === 'SELECTING_SOURCE') return <SourceSelector onSelect={selectSource} />

  if (source === 'my-device') {
    if (!myLocation.snapshot) return <MyLocationPermission request={myLocation.request} state={myLocation.state} onBack={returnToSelector} />
    return <MobileMapShell source="my-device" snapshot={myLocation.snapshot} trace={myLocation.trace} onChangeSource={returnToSelector} onStop={myLocation.stop} />
  }

  if (showSharedImporter) return <SharedImporter onCancel={() => setShowSharedImporter(false)} onSuccess={() => { setShowSharedImporter(false); void shared.refreshStatus() }} />
  if (shared.snapshot && ['SHARED_READY', 'SHARED_STALE', 'SHARED_NO_LOCATION'].includes(shared.state)) {
    return <MobileMapShell source="google-shared" snapshot={shared.snapshot} trace={shared.trace} onChangeSource={returnToSelector} onStop={shared.stop} />
  }
  return <SharedOnboarding onImport={() => setShowSharedImporter(true)} onBack={returnToSelector} status={shared.state} loading={shared.loading} />
}
