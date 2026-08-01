'use client'

import dynamic from 'next/dynamic'
import { useCallback, useMemo, useState } from 'react'
import { ChevronLeft, LocateFixed, MapPinned } from 'lucide-react'
import type { LocationSource, ProductFlow } from '@/lib/location-source/contracts'
import { isMapUnlocked } from '@/lib/location-source/contracts'
import { useMyLocation } from '@/lib/location-source/use-my-location'
import NativeSharingHub from './NativeSharingHub'

const MobileMapShell = dynamic(() => import('./MobileMapShell'), { ssr: false })
const SHARED_RUNTIME_AVAILABLE = process.env.NEXT_PUBLIC_STRACKER_SHARED_RUNTIME !== 'disabled'

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Volver" className="absolute left-3 top-[max(12px,env(safe-area-inset-top))] grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-white/[0.04]"><ChevronLeft size={22} /></button>
  )
}

function Selector({ onSelect }: { onSelect: (source: LocationSource) => void }) {
  return (
    <main className="flex min-h-[100dvh] w-full items-center justify-center overflow-x-hidden bg-black px-4 py-[max(20px,env(safe-area-inset-top))] text-white">
      <div className="w-full max-w-md">
        <header className="mb-7 text-center">
          <p className="text-xs font-semibold tracking-[0.28em] text-white/50">STRACKER</p>
          <h1 className="mt-3 text-2xl font-semibold">¿Qué ubicación querés ver?</h1>
        </header>
        <div className="grid gap-3">
          <button type="button" onClick={() => onSelect('my-device')} className="flex min-h-[112px] items-center gap-4 rounded-[24px] border border-white/10 bg-white/[0.035] p-4 text-left">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white text-black"><LocateFixed size={24} /></span>
            <span><strong className="block">MI UBICACIÓN</strong><span className="mt-1 block text-sm text-white/55">Usar la ubicación de este teléfono.</span></span>
          </button>
          <button type="button" onClick={() => onSelect('shared-location')} className="flex min-h-[112px] items-center gap-4 rounded-[24px] border border-white/10 bg-white/[0.035] p-4 text-left">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-white/15"><MapPinned size={24} /></span>
            <span><strong className="block">UBICACIÓN COMPARTIDA</strong><span className="mt-1 block text-sm text-white/55">Abrir o crear un enlace privado de STRACKER.</span></span>
          </button>
        </div>
        <p className="mt-5 text-center text-xs text-white/40">La elección no se guarda y vuelve a pedirse al abrir o recargar.</p>
        <p className="mt-3 text-center text-[11px] leading-5 text-white/35">Usá STRACKER sólo con ubicaciones propias o compartidas voluntariamente.</p>
      </div>
    </main>
  )
}

function MyOnboarding({ state, requestPermission, onBack }: { state: string; requestPermission: () => void; onBack: () => void }) {
  const error = useMemo(() => ({
    MY_LOCATION_PERMISSION_DENIED: 'Permiso denegado. Habilitá la ubicación para este sitio.',
    MY_LOCATION_UNAVAILABLE: 'El teléfono no pudo obtener una ubicación.',
    MY_LOCATION_TIMEOUT: 'La lectura tardó demasiado. Intentá nuevamente.',
    MY_LOCATION_ERROR: 'Ocurrió un error al consultar la ubicación.',
  }[state] || null), [state])
  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-x-hidden bg-black px-5 text-white">
      <BackButton onClick={onBack} />
      <div className="w-full max-w-sm text-center">
        <LocateFixed className="mx-auto" size={32} />
        <h1 className="mt-5 text-2xl font-semibold">Mi ubicación</h1>
        <p className="mt-3 text-sm leading-6 text-white/55">STRACKER necesita permiso para mostrar tu ubicación actual. Las coordenadas no se persisten ni se envían al proveedor compartido.</p>
        {error ? <p role="alert" className="mt-5 rounded-2xl border border-white/10 p-4 text-left text-sm">{error}</p> : null}
        <button type="button" onClick={requestPermission} disabled={state === 'MY_LOCATION_REQUESTING_PERMISSION'} className="mt-6 min-h-12 w-full rounded-2xl bg-white text-sm font-semibold text-black disabled:opacity-50">{state === 'MY_LOCATION_REQUESTING_PERMISSION' ? 'SOLICITANDO PERMISO…' : 'PERMITIR UBICACIÓN'}</button>
        <p className="mt-4 text-xs leading-5 text-white/35">El seguimiento puede pausarse en segundo plano o con ahorro de batería.</p>
      </div>
    </main>
  )
}

function SharedUnavailable({ onBack }: { onBack: () => void }) {
  return (
    <main data-shared-runtime="unavailable" className="relative flex min-h-[100dvh] items-center justify-center overflow-x-hidden bg-black px-5 text-white">
      <BackButton onClick={onBack} />
      <div className="w-full max-w-sm text-center">
        <MapPinned className="mx-auto" size={32} />
        <h1 className="mt-5 text-2xl font-semibold">Ubicación compartida</h1>
        <p role="status" className="mt-5 rounded-2xl border border-white/10 p-4 text-sm font-semibold">NO DISPONIBLE EN ESTA PREVIEW</p>
        <p className="mt-4 text-sm leading-6 text-white/55">El runtime compartido permanece cerrado hasta completar su validación independiente. No se inicia ninguna sesión, consulta, mapa ni geolocalización.</p>
      </div>
    </main>
  )
}

export default function MobileLocationApp() {
  const [flow, setFlow] = useState<ProductFlow>('SELECTING_SOURCE')
  const [source, setSource] = useState<LocationSource | null>(null)
  const my = useMyLocation()

  const select = useCallback((next: LocationSource) => {
    my.stop()
    setSource(next)
    setFlow(next === 'my-device' ? 'MY_LOCATION_FLOW' : 'SHARED_LOCATION_FLOW')
  }, [my])

  const reset = useCallback(() => {
    my.stop()
    setSource(null)
    setFlow('SELECTING_SOURCE')
  }, [my])

  if (flow === 'SELECTING_SOURCE' || !source) return <Selector onSelect={select} />
  if (source === 'shared-location') {
    return SHARED_RUNTIME_AVAILABLE
      ? <NativeSharingHub onBack={reset} />
      : <SharedUnavailable onBack={reset} />
  }
  return isMapUnlocked(source, my.state, 'unconfirmed') && my.snapshot
    ? <MobileMapShell source="my-device" snapshot={my.snapshot} ghostrail={my.ghostrail} onChangeSource={reset} onStop={reset} />
    : <MyOnboarding state={my.state} requestPermission={my.requestPermission} onBack={reset} />
}
