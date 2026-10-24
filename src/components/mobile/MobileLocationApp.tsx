'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, LocateFixed, MapPinned, ShieldCheck } from 'lucide-react'
import type { LocationSource, ProductFlow, SharedSessionStatus } from '@/lib/location-source/contracts'
import { isMapUnlocked } from '@/lib/location-source/contracts'
import { useMyLocation } from '@/lib/location-source/use-my-location'
import { useSharedLocation } from '@/lib/location-source/use-shared-location'

const MobileMapShell = dynamic(() => import('./MobileMapShell'), { ssr: false })
const SOURCE_KEY = 'stracker.lastSelectedSource'
const IS_STAGING_MOCK = process.env.NEXT_PUBLIC_STRACKER_STAGING_MOCK === '1'
const SYNTHETIC_SESSION_MARKER = 'MOCK_SESSION_ONLY'

type DetectedFormat =
  | 'Cookie Editor JSON'
  | 'JSON envuelto'
  | 'Cookie Header String'
  | 'Netscape'
  | 'Sin detectar'

function detectFormat(raw: string): DetectedFormat {
  const value = raw.trim()
  if (!value) return 'Sin detectar'
  if (
    value.startsWith('# Netscape HTTP Cookie File') ||
    value.split('\n').some((line) => line.split('\t').length >= 7)
  ) return 'Netscape'
  if (value.startsWith('[')) return 'Cookie Editor JSON'
  if (value.startsWith('{')) return 'JSON envuelto'
  if (value.includes('=') && value.includes(';')) return 'Cookie Header String'
  return 'Sin detectar'
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Volver"
      className="absolute left-3 top-[max(12px,env(safe-area-inset-top))] grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-white/[0.04]"
    >
      <ChevronLeft size={22} />
    </button>
  )
}

function StagingBadge() {
  if (!IS_STAGING_MOCK) return null
  return (
    <p className="mx-auto mb-4 w-fit rounded-full border border-white/15 px-3 py-1 text-[11px] font-semibold tracking-[0.16em] text-white/65">
      STAGING SINTÉTICO · DATOS NO REALES
    </p>
  )
}

function Selector({ onSelect }: { onSelect: (source: LocationSource) => void }) {
  return (
    <main className="flex min-h-[100dvh] w-full items-center justify-center overflow-x-hidden bg-black px-4 py-[max(20px,env(safe-area-inset-top))] text-white">
      <div className="w-full max-w-md">
        <header className="mb-7 text-center">
          <StagingBadge />
          <p className="text-xs font-semibold tracking-[0.28em] text-white/50">STRACKER</p>
          <h1 className="mt-3 text-2xl font-semibold">¿Qué ubicación querés ver?</h1>
        </header>
        <div className="grid gap-3">
          <button
            type="button"
            onClick={() => onSelect('my-device')}
            className="flex min-h-[112px] items-center gap-4 rounded-[24px] border border-white/10 bg-white/[0.035] p-4 text-left"
          >
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white text-black">
              <LocateFixed size={24} />
            </span>
            <span>
              <strong className="block">MI UBICACIÓN</strong>
              <span className="mt-1 block text-sm text-white/55">Usar la ubicación de este teléfono.</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => onSelect('google-shared')}
            className="flex min-h-[112px] items-center gap-4 rounded-[24px] border border-white/10 bg-white/[0.035] p-4 text-left"
          >
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-white/15">
              <MapPinned size={24} />
            </span>
            <span>
              <strong className="block">UBICACIÓN COMPARTIDA</strong>
              <span className="mt-1 block text-sm text-white/55">
                {IS_STAGING_MOCK
                  ? 'Ver la ubicación sintética del backend mock interno.'
                  : 'Ver una ubicación compartida conmigo en Google Maps.'}
              </span>
            </span>
          </button>
        </div>
        <p className="mt-5 text-center text-xs text-white/40">Podés cambiar de modo más adelante.</p>
        <p className="mt-3 text-center text-[11px] leading-5 text-white/35">
          {IS_STAGING_MOCK
            ? 'Este entorno no acepta cookies, sesiones ni coordenadas reales.'
            : 'Usá STRACKER sólo con ubicaciones propias o compartidas voluntariamente.'}
        </p>
      </div>
    </main>
  )
}

function MyOnboarding({
  state,
  requestPermission,
  onBack,
}: {
  state: string
  requestPermission: () => void
  onBack: () => void
}) {
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
        <StagingBadge />
        <LocateFixed className="mx-auto" size={32} />
        <h1 className="mt-5 text-2xl font-semibold">Mi ubicación</h1>
        <p className="mt-3 text-sm leading-6 text-white/55">
          STRACKER necesita permiso para mostrar tu ubicación actual. La lectura queda en este navegador.
        </p>
        {error ? <p role="alert" className="mt-5 rounded-2xl border border-white/10 p-4 text-left text-sm">{error}</p> : null}
        <button
          type="button"
          onClick={requestPermission}
          disabled={state === 'MY_LOCATION_REQUESTING_PERMISSION'}
          className="mt-6 min-h-12 w-full rounded-2xl bg-white text-sm font-semibold text-black disabled:opacity-50"
        >
          {state === 'MY_LOCATION_REQUESTING_PERMISSION' ? 'SOLICITANDO PERMISO…' : 'PERMITIR UBICACIÓN'}
        </button>
        <p className="mt-4 text-xs leading-5 text-white/35">
          El seguimiento puede pausarse en segundo plano o con ahorro de batería.
        </p>
      </div>
    </main>
  )
}

function SyntheticSharedImporter({
  loading,
  error,
  onBack,
  onImport,
}: {
  loading: boolean
  error: string | null
  onBack: () => void
  onImport: (raw: string) => Promise<void>
}) {
  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-x-hidden bg-black px-5 text-white">
      <BackButton onClick={onBack} />
      <div className="w-full max-w-sm text-center">
        <StagingBadge />
        <MapPinned className="mx-auto" size={34} />
        <h1 className="mt-5 text-2xl font-semibold">Ubicación compartida sintética</h1>
        <p className="mt-3 text-sm leading-6 text-white/55">
          Activa un escenario falso de laboratorio. No pegues cookies, sesiones ni coordenadas reales.
        </p>
        {error ? <p role="alert" className="mt-5 rounded-2xl border border-white/10 p-4 text-left text-sm">{error}</p> : null}
        <button
          type="button"
          disabled={loading}
          onClick={() => void onImport(SYNTHETIC_SESSION_MARKER)}
          className="mt-6 min-h-12 w-full rounded-2xl bg-white text-sm font-semibold text-black disabled:opacity-40"
        >
          {loading ? 'ACTIVANDO DATOS SINTÉTICOS…' : 'ACTIVAR DATOS SINTÉTICOS'}
        </button>
        <div className="mt-5 flex gap-3 text-left text-xs leading-5 text-white/40">
          <ShieldCheck size={16} className="shrink-0" />
          <p>El backend mock no persiste estado y sólo devuelve el dataset STRACKER_STAGING_SYNTHETIC_V1.</p>
        </div>
      </div>
    </main>
  )
}

function SharedImporter({
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
  const ref = useRef<HTMLTextAreaElement | null>(null)

  if (IS_STAGING_MOCK) {
    return <SyntheticSharedImporter loading={loading} error={error} onBack={onBack} onImport={onImport} />
  }

  const paste = async () => {
    try {
      setRaw(await navigator.clipboard.readText())
      ref.current?.focus()
      setLocalError(null)
    } catch {
      setLocalError('No se pudo leer el portapapeles. Pegá manualmente.')
    }
  }
  const submit = async () => {
    if (!raw.trim()) {
      setLocalError('Pegá una sesión antes de importar.')
      return
    }
    setLocalError(null)
    await onImport(raw)
  }

  return (
    <main className="relative min-h-[100dvh] overflow-x-hidden bg-black px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-[max(76px,calc(env(safe-area-inset-top)+64px))] text-white">
      <BackButton onClick={onBack} />
      <div className="mx-auto max-w-md">
        <p className="text-xs font-semibold tracking-[0.18em] text-white/45">UBICACIÓN COMPARTIDA</p>
        <h1 className="mt-2 text-2xl font-semibold">Vincular sesión de Google Maps</h1>
        <p className="mt-3 text-sm leading-6 text-white/55">
          Importá una sesión autorizada para consultar una ubicación ya compartida con tu cuenta.
        </p>
        <div className="mt-5 rounded-[22px] border border-white/10 p-3">
          <div className="mb-2 flex justify-between text-xs">
            <span className="text-white/45">Formato detectado</span>
            <strong>{detectFormat(raw)}</strong>
          </div>
          <textarea
            ref={ref}
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="min-h-[180px] w-full resize-y rounded-2xl border border-white/10 bg-black p-3 font-mono text-[13px]"
            placeholder="Cookie Editor JSON, Header String o Netscape…"
          />
          <button type="button" onClick={paste} className="mt-2 min-h-11 w-full rounded-2xl border border-white/15 text-sm font-semibold">
            PEGAR
          </button>
        </div>
        {localError || error ? (
          <div role="alert" className="mt-3 rounded-2xl border border-white/10 p-4 text-sm">
            <p>{localError || error}</p>
            <p className="mt-2 text-white/50">Revisá el formato o renová la sesión.</p>
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
          onClick={() => void submit()}
          className="mt-4 min-h-12 w-full rounded-2xl bg-white text-sm font-semibold text-black disabled:opacity-40"
        >
          {loading ? 'VALIDANDO SESIÓN…' : 'IMPORTAR Y VALIDAR'}
        </button>
        <div className="mt-5 flex gap-3 text-xs leading-5 text-white/40">
          <ShieldCheck size={16} className="shrink-0" />
          <p>Los valores quedan en el backend privado y nunca vuelven al navegador.</p>
        </div>
      </div>
    </main>
  )
}

export default function MobileLocationApp() {
  const [initialSource] = useState<LocationSource | null>(() => {
    if (typeof window === 'undefined') return null
    const stored = window.localStorage.getItem(SOURCE_KEY)
    return stored === 'my-device' || stored === 'google-shared' ? stored : null
  })
  const [flow, setFlow] = useState<ProductFlow>(() => (
    initialSource === 'my-device'
      ? 'MY_LOCATION_FLOW'
      : initialSource === 'google-shared'
        ? 'SHARED_LOCATION_FLOW'
        : 'SELECTING_SOURCE'
  ))
  const [source, setSource] = useState<LocationSource | null>(initialSource)
  const [importing, setImporting] = useState(false)
  const my = useMyLocation()
  const shared = useSharedLocation()
  const sharedStatusRefreshRef = useRef(shared.refreshStatus)

  const select = useCallback((next: LocationSource) => {
    my.stop()
    shared.stop()
    setSource(next)
    window.localStorage.setItem(SOURCE_KEY, next)
    setFlow(next === 'my-device' ? 'MY_LOCATION_FLOW' : 'SHARED_LOCATION_FLOW')
    setImporting(false)
  }, [my, shared])

  useEffect(() => {
    if (source === 'google-shared' && flow === 'SHARED_LOCATION_FLOW') {
      void sharedStatusRefreshRef.current()
    }
  }, [source, flow])

  const reset = useCallback(() => {
    my.stop()
    shared.stop()
    setSource(null)
    setFlow('SELECTING_SOURCE')
    setImporting(false)
  }, [my, shared])

  if (flow === 'SELECTING_SOURCE' || !source) return <Selector onSelect={select} />

  if (source === 'my-device') {
    return isMapUnlocked(source, my.state, shared.state) && my.snapshot
      ? (
          <MobileMapShell
            source="my-device"
            snapshot={my.snapshot}
            ghostrail={[]}
            trackingLabel={my.tracking ? 'ACTIVA' : 'PAUSADA'}
            sessionLabel={IS_STAGING_MOCK ? 'LOCAL · STAGING' : 'Local'}
            onChangeSource={reset}
            onStop={() => { my.stop(); reset() }}
          />
        )
      : <MyOnboarding state={my.state} requestPermission={my.requestPermission} onBack={reset} />
  }

  if (!importing && isMapUnlocked(source, my.state, shared.state) && shared.snapshot) {
    return (
      <MobileMapShell
        source="google-shared"
        snapshot={shared.snapshot}
        ghostrail={shared.ghostrail}
        trackingLabel={shared.state === 'SHARED_READY' ? 'ACTIVA' : shared.state === 'SHARED_STALE' ? 'STALE' : 'SIN UBICACIÓN'}
        sessionLabel={IS_STAGING_MOCK ? 'SINTÉTICO' : shared.status?.health || 'VALID'}
        onChangeSource={reset}
        onReplaceSession={() => setImporting(true)}
        onDeleteSession={() => void shared.deleteSession().then(reset)}
      />
    )
  }

  if (
    !importing &&
    source === 'google-shared' &&
    shared.rememberedSession &&
    !shared.snapshot &&
    (!shared.status || shared.status.configured || shared.state === 'SHARED_ERROR')
  ) {
    return (
      <main className="relative flex min-h-[100dvh] items-center justify-center overflow-x-hidden bg-black px-5 text-white">
        <BackButton onClick={reset} />
        <div className="w-full max-w-sm text-center">
          <MapPinned className="mx-auto" size={34} />
          <h1 className="mt-5 text-2xl font-semibold">
            {shared.state === 'SHARED_NO_LOCATION' ? 'Sesión guardada' : 'Recuperando sesión guardada'}
          </h1>
          <p className="mt-3 text-sm leading-6 text-white/55">
            {shared.state === 'SHARED_NO_LOCATION'
              ? 'La sesión de Google Maps sigue vinculada, pero no hay una ubicación compartida activa disponible ahora. No hace falta volver a pegar las cookies.'
              : 'STRACKER está intentando recuperar la sesión guardada. Si el backend no responde, se puede reintentar sin volver a pegar las cookies.'}
          </p>
          {shared.error ? <p role="alert" className="mt-4 rounded-2xl border border-white/10 p-3 text-sm">{shared.error}</p> : null}
          <button
            type="button"
            disabled={shared.loading}
            onClick={() => void sharedStatusRefreshRef.current()}
            className="mt-6 min-h-12 w-full rounded-2xl bg-white text-sm font-semibold text-black disabled:opacity-40"
          >
            {shared.loading ? 'CONSULTANDO…' : 'VOLVER A CONSULTAR'}
          </button>
          <button
            type="button"
            onClick={() => setImporting(true)}
            className="mt-3 min-h-11 w-full rounded-2xl border border-white/15 text-sm font-semibold"
          >
            REEMPLAZAR SESIÓN
          </button>
        </div>
      </main>
    )
  }

  return (
    <SharedImporter
      status={shared.status}
      loading={shared.loading}
      error={shared.error}
      onBack={reset}
      onImport={async (raw) => {
        const result = await shared.importSession(raw)
        if (['SHARED_READY', 'SHARED_STALE', 'SHARED_NO_LOCATION'].includes(result.state)) setImporting(false)
      }}
    />
  )
}
