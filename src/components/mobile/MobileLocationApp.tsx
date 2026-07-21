'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, LocateFixed, MapPinned, ShieldCheck } from 'lucide-react'
import type {
  LocationSource,
  ProductFlow,
  SharedSessionStatus,
} from '@/lib/location-source/contracts'
import { isMapUnlocked } from '@/lib/location-source/contracts'
import { useMyLocation } from '@/lib/location-source/use-my-location'
import { useSharedLocation } from '@/lib/location-source/use-shared-location'

const MobileMapShell = dynamic(() => import('./MobileMapShell'), {
  ssr: false,
  loading: () => <FullScreenMessage title="Cargando mapa…" />,
})

const SOURCE_KEY = 'stracker.lastSelectedSource'

type DetectedFormat =
  | 'Cookie Editor JSON'
  | 'JSON envuelto'
  | 'Cookie Header String'
  | 'Netscape'
  | 'Sin detectar'

function detectFormat(raw: string): DetectedFormat {
  const value = raw.trim()
  if (!value) return 'Sin detectar'
  if (value.startsWith('# Netscape HTTP Cookie File') || value.split('\n').some((line) => line.split('\t').length >= 7)) {
    return 'Netscape'
  }
  if (value.startsWith('[')) return 'Cookie Editor JSON'
  if (value.startsWith('{')) return 'JSON envuelto'
  if (value.includes('=') && value.includes(';')) return 'Cookie Header String'
  return 'Sin detectar'
}

function FullScreenMessage({ title, detail }: { title: string; detail?: string }) {
  return (
    <main className="grid min-h-[100dvh] w-full place-items-center overflow-x-hidden bg-black px-6 text-center text-white">
      <div className="max-w-sm">
        <p className="text-lg font-semibold">{title}</p>
        {detail ? <p className="mt-2 text-sm leading-6 text-white/55">{detail}</p> : null}
      </div>
    </main>
  )
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute left-3 top-[max(12px,env(safe-area-inset-top))] grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-white/[0.04]"
      aria-label="Volver"
    >
      <ChevronLeft size={22} />
    </button>
  )
}

function Selector({ onSelect }: { onSelect: (source: LocationSource) => void }) {
  return (
    <main className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-x-hidden bg-black px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-[max(20px,env(safe-area-inset-top))] text-white">
      <div className="w-full max-w-md">
        <header className="mb-7 text-center">
          <p className="text-xs font-semibold tracking-[0.28em] text-white/50">STRACKER</p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">¿Qué ubicación querés ver?</h1>
        </header>

        <div className="grid gap-3">
          <button
            type="button"
            onClick={() => onSelect('my-device')}
            className="flex min-h-[112px] w-full items-center gap-4 rounded-[24px] border border-white/10 bg-white/[0.035] p-4 text-left active:scale-[0.99]"
          >
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white text-black">
              <LocateFixed size={24} />
            </span>
            <span className="min-w-0">
              <strong className="block text-base">MI UBICACIÓN</strong>
              <span className="mt-1 block text-sm leading-5 text-white/55">Usar la ubicación de este teléfono.</span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => onSelect('google-shared')}
            className="flex min-h-[112px] w-full items-center gap-4 rounded-[24px] border border-white/10 bg-white/[0.035] p-4 text-left active:scale-[0.99]"
          >
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-white/15">
              <MapPinned size={24} />
            </span>
            <span className="min-w-0">
              <strong className="block text-base">UBICACIÓN COMPARTIDA</strong>
              <span className="mt-1 block text-sm leading-5 text-white/55">Ver una ubicación que alguien comparte conmigo en Google Maps.</span>
            </span>
          </button>
        </div>

        <p className="mt-5 text-center text-xs leading-5 text-white/40">Podés cambiar de modo más adelante.</p>
        <p className="mt-3 text-center text-[11px] leading-5 text-white/35">STRACKER sólo debe usarse con ubicaciones propias o compartidas voluntariamente con tu cuenta.</p>
      </div>
    </main>
  )
}

function MyLocationOnboarding({ onBack, onReady }: { onBack: () => void; onReady: () => void }) {
  const myLocation = useMyLocation()

  useEffect(() => {
    if (myLocation.state === 'MY_LOCATION_READY' && myLocation.snapshot) onReady()
  }, [myLocation.snapshot, myLocation.state, onReady])

  const errorCopy = useMemo(() => {
    switch (myLocation.state) {
      case 'MY_LOCATION_PERMISSION_DENIED':
        return 'Permiso denegado. Habilitá la ubicación para este sitio desde la configuración del navegador.'
      case 'MY_LOCATION_UNAVAILABLE':
        return 'El teléfono no pudo obtener una ubicación válida.'
      case 'MY_LOCATION_TIMEOUT':
        return 'La lectura tardó demasiado. Movete a un lugar con mejor señal e intentá nuevamente.'
      case 'MY_LOCATION_ERROR':
        return 'Ocurrió un error al consultar la ubicación del teléfono.'
      default:
        return null
    }
  }, [myLocation.state])

  return (
    <main className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-x-hidden bg-black px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-[max(76px,calc(env(safe-area-inset-top)+64px))] text-white">
      <BackButton onClick={() => { myLocation.stop(); onBack() }} />
      <div className="w-full max-w-sm text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white text-black"><LocateFixed size={28} /></span>
        <h1 className="mt-5 text-2xl font-semibold">Mi ubicación</h1>
        <p className="mt-3 text-sm leading-6 text-white/55">STRACKER necesita permiso para mostrar tu ubicación actual. La lectura se usa únicamente dentro del mapa y no se envía al backend por defecto.</p>

        {errorCopy ? (
          <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-left text-sm leading-6">
            <p>{errorCopy}</p>
          </div>
        ) : null}

        <button
          type="button"
          onClick={myLocation.requestPermission}
          disabled={myLocation.state === 'MY_LOCATION_REQUESTING_PERMISSION'}
          className="mt-6 min-h-12 w-full rounded-2xl bg-white px-5 text-sm font-semibold text-black disabled:opacity-50"
        >
          {myLocation.state === 'MY_LOCATION_REQUESTING_PERMISSION' ? 'SOLICITANDO PERMISO…' : 'PERMITIR UBICACIÓN'}
        </button>
        <p className="mt-4 text-xs leading-5 text-white/35">El seguimiento puede pausarse cuando la pestaña queda en segundo plano, el teléfono se bloquea o el sistema limita la batería.</p>
      </div>
    </main>
  )
}

function SharedOnboarding({
  status,
  loading,
  error,
  onBack,
  onImport,
}: {
  status: SharedSessionStatus | null
  loading: boolean
  error: string | null
  onBack: () => void
  onImport: (raw: string) => Promise<void>
}) {
  const [raw, setRaw] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const format = detectFormat(raw)

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      setRaw(text)
      setLocalError(null)
      textareaRef.current?.focus()
    } catch {
      setLocalError('No se pudo leer el portapapeles. Pegá el contenido manualmente.')
    }
  }

  const submit = async () => {
    if (!raw.trim()) {
      setLocalError('Pegá una sesión antes de importar.')
      return
    }
    setLocalError(null)
    try {
      await onImport(raw)
      setRaw('')
    } catch {
      // The controller exposes a sanitized actionable message.
    }
  }

  return (
    <main className="relative min-h-[100dvh] w-full overflow-x-hidden bg-black px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-[max(76px,calc(env(safe-area-inset-top)+64px))] text-white">
      <BackButton onClick={onBack} />
      <div className="mx-auto w-full max-w-md">
        <header>
          <p className="text-xs font-semibold tracking-[0.18em] text-white/45">UBICACIÓN COMPARTIDA</p>
          <h1 className="mt-2 text-2xl font-semibold">Vincular sesión de Google Maps</h1>
          <p className="mt-3 text-sm leading-6 text-white/55">Importá una sesión autorizada para consultar una ubicación que ya comparten voluntariamente con tu cuenta.</p>
        </header>

        <div className="mt-5 rounded-[22px] border border-white/10 bg-white/[0.035] p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs text-white/45">Formato detectado</span>
            <strong className="text-xs">{format}</strong>
          </div>
          <textarea
            ref={textareaRef}
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="Pegá Cookie Editor JSON, Header String o archivo Netscape…"
            className="min-h-[180px] w-full resize-y rounded-2xl border border-white/10 bg-black p-3 font-mono text-[13px] leading-5 outline-none placeholder:text-white/25 focus:border-white/30"
          />
          <button type="button" onClick={paste} className="mt-2 min-h-11 w-full rounded-2xl border border-white/15 text-sm font-semibold">PEGAR</button>
        </div>

        {(localError || error) ? (
          <div role="alert" className="mt-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm leading-6">
            <p>{localError || error}</p>
            <p className="mt-2 text-white/50">Revisá el formato, renová la sesión en Google Maps y volvé a intentarlo.</p>
          </div>
        ) : null}

        {status ? (
          <div className="mt-3 grid grid-cols-2 gap-2 rounded-2xl border border-white/10 p-3 text-xs">
            <span className="text-white/45">Cookies válidas</span><strong className="text-right">{status.count}</strong>
            <span className="text-white/45">Críticas presentes</span><strong className="text-right">{status.criticalPresent.length}</strong>
            <span className="text-white/45">Críticas faltantes</span><strong className="text-right">{status.criticalMissing.length}</strong>
            <span className="text-white/45">Validación</span><strong className="text-right">{status.health}</strong>
          </div>
        ) : null}

        <button
          type="button"
          disabled={loading || !raw.trim()}
          onClick={submit}
          className="mt-4 min-h-12 w-full rounded-2xl bg-white px-5 text-sm font-semibold text-black disabled:opacity-40"
        >
          {loading ? 'VALIDANDO SESIÓN…' : 'IMPORTAR Y VALIDAR'}
        </button>

        <div className="mt-5 flex gap-3 text-xs leading-5 text-white/40">
          <ShieldCheck className="mt-0.5 shrink-0" size={16} />
          <p>Los valores se envían al backend privado, no se guardan en localStorage y nunca vuelven a mostrarse en el navegador.</p>
        </div>
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
    const stored = window.localStorage.getItem(SOURCE_KEY)
    if (stored === 'my-device' || stored === 'google-shared') {
      setSource(stored)
    }
  }, [])

  const selectSource = useCallback((next: LocationSource) => {
    myLocation.stop()
    shared.stop()
    setSource(next)
    window.localStorage.setItem(SOURCE_KEY, next)
    if (next === 'my-device') {
      setFlow('MY_LOCATION_FLOW')
    } else {
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

  if (flow === 'SELECTING_SOURCE' || !source) return <Selector onSelect={selectSource} />

  if (source === 'my-device') {
    if (isMapUnlocked(source, myLocation.state, shared.state) && myLocation.snapshot) {
      return (
        <MobileMapShell
          source="my-device"
          snapshot={myLocation.snapshot}
          ghostrail={[]}
          trackingLabel={myLocation.tracking ? 'ACTIVA' : 'PAUSADA'}
          sessionLabel="Local"
          onChangeSource={returnToSelector}
          onStop={() => { myLocation.stop(); returnToSelector() }}
        />
      )
    }
    return <MyLocationOnboarding onBack={returnToSelector} onReady={() => undefined} />
  }

  const sharedUnlocked = isMapUnlocked(source, myLocation.state, shared.state)
  if (sharedUnlocked && shared.snapshot && !showSharedImporter) {
    return (
      <MobileMapShell
        source="google-shared"
        snapshot={shared.snapshot}
        ghostrail={shared.ghostrail}
        trackingLabel={shared.state === 'SHARED_READY' ? 'ACTIVA' : shared.state === 'SHARED_STALE' ? 'STALE' : 'SIN UBICACIÓN'}
        sessionLabel={shared.status?.health || 'VALID'}
        onChangeSource={returnToSelector}
        onReplaceSession={() => setShowSharedImporter(true)}
        onDeleteSession={() => { void shared.deleteSession().then(returnToSelector) }}
      />
    )
  }

  if (shared.loading && !showSharedImporter && !shared.status) {
    return <FullScreenMessage title="Validando sesión…" detail="Comprobando el estado real del backend y de Google Maps." />
  }

  return (
    <SharedOnboarding
      status={shared.status}
      loading={shared.loading}
      error={shared.error}
      onBack={returnToSelector}
      onImport={async (raw) => {
        const result = await shared.importSession(raw)
        if (result.state === 'SHARED_READY' || result.state === 'SHARED_STALE' || result.state === 'SHARED_NO_LOCATION') {
          setShowSharedImporter(false)
        }
      }}
    />
  )
}
