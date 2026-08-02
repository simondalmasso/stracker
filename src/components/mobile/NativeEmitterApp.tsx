'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, Copy, Crosshair, Link2, Radio, RotateCcw, Share2, ShieldAlert, Wifi, WifiOff } from 'lucide-react'
import { viewerFragmentLink } from '@/lib/location-source/native-sharing-api'
import { useNativeEmitter } from '@/lib/location-source/use-native-emitter'

const DURATIONS = [
  { label: '15 MIN', ms: 15 * 60_000 },
  { label: '1 HORA', ms: 60 * 60_000 },
  { label: '4 HORAS', ms: 4 * 60 * 60_000 },
]

function durationText(value: number | null): string {
  if (value === null) return '—'
  const seconds = Math.max(0, Math.ceil(value / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return hours ? `${hours}H ${minutes}M` : `${minutes}M ${rest}S`
}

function updateText(value: string | null): string {
  if (!value) return 'SIN ENVÍOS CONFIRMADOS'
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000))
  if (seconds < 5) return 'AHORA'
  if (seconds <= 45) return `HACE ${seconds}S`
  return `DEMORADA · HACE ${seconds}S`
}

function networkText(value: string): string {
  return ({
    online: 'EN LÍNEA',
    offline: 'SIN CONEXIÓN',
    sending: 'ENVIANDO',
    recovering: 'RECUPERANDO',
    error: 'REQUIERE ACCIÓN',
  } as Record<string, string>)[value] || value.toUpperCase()
}

function accuracyText(value: string): string {
  return ({ good: 'BUENA', fair: 'MEDIA', low: 'BAJA', unknown: 'SIN DATO' } as Record<string, string>)[value] || 'SIN DATO'
}

export default function NativeEmitterApp() {
  const emitter = useNativeEmitter()
  const [durationMs, setDurationMs] = useState(DURATIONS[1].ms)
  const [copied, setCopied] = useState(false)
  const [diagnosticCopied, setDiagnosticCopied] = useState(false)
  const [shareSupported, setShareSupported] = useState(false)

  useEffect(() => setShareSupported(typeof navigator.share === 'function'), [])

  const link = useMemo(() => {
    if (!emitter.session) return null
    const origin = typeof window === 'undefined' ? '' : window.location.origin
    return viewerFragmentLink(emitter.session.viewerCapability, origin)
  }, [emitter.session])
  const started = emitter.state !== 'not-started' && emitter.state !== 'requesting-permission' && emitter.session !== null

  const copy = async () => {
    if (!link) return
    await navigator.clipboard.writeText(link)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const share = async () => {
    if (!link || typeof navigator.share !== 'function') return
    await navigator.share({ title: 'Ubicación compartida · STRACKER', text: 'Abrí este enlace privado para ver mi ubicación.', url: link }).catch(() => undefined)
  }

  const copyDiagnostic = async () => {
    const diagnostic = await emitter.getDiagnostic()
    await navigator.clipboard.writeText(diagnostic)
    setDiagnosticCopied(true)
    window.setTimeout(() => setDiagnosticCopied(false), 1500)
  }

  const goBack = async () => {
    if (emitter.session && emitter.state !== 'revoked' && emitter.state !== 'expired') {
      try {
        await emitter.stopTransmission()
      } catch {
        return
      }
    }
    window.location.assign('/')
  }

  const showDiagnostic = Boolean(emitter.error) || emitter.networkState === 'offline' || emitter.networkState === 'recovering' || emitter.networkState === 'error'

  return (
    <main className="relative min-h-[100dvh] overflow-x-hidden bg-black px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-[max(76px,calc(env(safe-area-inset-top)+64px))] text-white" data-sharing-state={emitter.state} data-network-state={emitter.networkState} data-wake-lock-held={emitter.wakeLockHeld ? 'true' : 'false'} data-visibility-state={emitter.visibilityState}>
      <button type="button" onClick={() => void goBack()} aria-label="Volver" className="absolute left-3 top-[max(12px,env(safe-area-inset-top))] grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-white/[0.04]"><ChevronLeft size={22} /></button>
      <div className="mx-auto max-w-md">
        <p className="text-xs font-semibold tracking-[0.18em] text-white/45">COMPARTIR CON STRACKER</p>
        <h1 className="mt-2 text-2xl font-semibold">Compartir mi ubicación</h1>
        {!started ? (
          <>
            <section className="mt-6 rounded-[24px] border border-white/10 p-4">
              <p className="text-xs font-semibold text-white/45">DURACIÓN</p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {DURATIONS.map((duration) => <button key={duration.ms} type="button" aria-pressed={durationMs === duration.ms} onClick={() => setDurationMs(duration.ms)} className={`min-h-11 rounded-2xl text-xs font-semibold ${durationMs === duration.ms ? 'bg-white text-black' : 'border border-white/10 text-white/70'}`}>{duration.label}</button>)}
              </div>
            </section>
            <section className="mt-3 grid gap-3 rounded-[24px] border border-white/10 p-4 text-sm leading-6">
              <div><p className="text-xs font-semibold text-white/45">QUIÉN PODRÁ VERLA</p><p className="mt-1 text-white/75">Cualquier persona que reciba el enlace privado mientras siga vigente.</p></div>
              <div><p className="text-xs font-semibold text-white/45">SÓLO EN PRIMER PLANO</p><p className="mt-1 text-white/75">Mantené Chrome visible y el teléfono desbloqueado. Bloquear la pantalla, cambiar de aplicación o el ahorro de batería puede pausar los envíos. STRACKER no promete seguimiento en segundo plano.</p></div>
              <div><p className="text-xs font-semibold text-white/45">AYUDA DE PANTALLA</p><p className="mt-1 text-white/75">Si el navegador lo permite, STRACKER intentará mantener la pantalla activa. Es una ayuda opcional y puede fallar sin detener la transmisión.</p></div>
            </section>
            {emitter.error ? <p role="alert" className="mt-3 rounded-2xl border border-white/10 p-4 text-sm leading-6">{emitter.error}</p> : null}
            <button type="button" disabled={emitter.state === 'requesting-permission'} onClick={() => emitter.start(durationMs)} className="mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white text-sm font-semibold text-black disabled:opacity-50"><Radio size={18} />{emitter.state === 'requesting-permission' ? 'SOLICITANDO PERMISO…' : 'INICIAR TRANSMISIÓN'}</button>
            <p className="mt-4 text-center text-xs leading-5 text-white/35">La geolocalización y la sesión se solicitan únicamente después de este botón.</p>
          </>
        ) : (
          <>
            <section className="mt-6 grid grid-cols-2 gap-2 text-xs" aria-label="Estado del piloto">
              <div className="rounded-2xl border border-white/10 p-3"><p className="text-white/45">TRANSMISIÓN</p><p className="mt-1 font-semibold">{emitter.state.toUpperCase()}</p></div>
              <div className="rounded-2xl border border-white/10 p-3"><p className="text-white/45">RED</p><p className="mt-1 flex items-center gap-1.5 font-semibold">{emitter.networkState === 'offline' ? <WifiOff size={14} /> : <Wifi size={14} />}{networkText(emitter.networkState)}</p></div>
              <div className="rounded-2xl border border-white/10 p-3"><p className="text-white/45">ÚLTIMO ENVÍO</p><p className="mt-1 font-semibold">{updateText(emitter.lastUpdate)}</p></div>
              <div className="rounded-2xl border border-white/10 p-3"><p className="text-white/45">PRECISIÓN</p><p className="mt-1 flex items-center gap-1.5 font-semibold"><Crosshair size={14} />{accuracyText(emitter.accuracyState)}</p></div>
              <div className="rounded-2xl border border-white/10 p-3"><p className="text-white/45">PÁGINA</p><p className="mt-1 font-semibold">{emitter.visibilityState === 'visible' ? 'VISIBLE' : 'PAUSADA'}</p></div>
              <div className="rounded-2xl border border-white/10 p-3"><p className="text-white/45">PANTALLA ACTIVA</p><p className="mt-1 font-semibold">{emitter.wakeLockSupported ? emitter.wakeLockHeld ? 'AYUDA ACTIVA' : 'NO RETENIDA' : 'NO SOPORTADA'}</p></div>
              <div className="col-span-2 rounded-2xl border border-white/10 p-3"><p className="text-white/45">DURACIÓN RESTANTE</p><p className="mt-1 font-semibold">{durationText(emitter.remainingMs)}</p></div>
            </section>
            {link ? (
              <section className="mt-3 rounded-[24px] border border-white/10 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold text-white/45"><Link2 size={15} />ENLACE PRIVADO</div>
                <input readOnly value={link} aria-label="Enlace privado de espectador" className="mt-3 min-h-12 w-full rounded-2xl border border-white/10 bg-black px-3 font-mono text-xs" />
                <div className={`mt-2 grid gap-2 ${shareSupported ? 'grid-cols-2' : 'grid-cols-1'}`}>
                  <button type="button" onClick={() => void copy()} className="flex min-h-11 items-center justify-center gap-2 rounded-2xl bg-white text-sm font-semibold text-black"><Copy size={17} />{copied ? 'COPIADO' : 'COPIAR'}</button>
                  {shareSupported ? <button type="button" onClick={() => void share()} className="flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-white/15 text-sm font-semibold"><Share2 size={17} />COMPARTIR</button> : null}
                </div>
                <p className="mt-3 text-xs leading-5 text-white/40">El enlace contiene la capacidad viewer sólo en `#v=`. No se guarda en el dispositivo ni se incluye en diagnósticos.</p>
              </section>
            ) : null}
            {emitter.error ? <p role="alert" className="mt-3 rounded-2xl border border-white/10 p-4 text-sm leading-6">{emitter.error}</p> : null}
            {showDiagnostic ? <section className="mt-3 rounded-[24px] border border-white/10 p-4"><p className="text-xs font-semibold text-white/45">DIAGNÓSTICO SEGURO</p><p className="mt-2 text-xs leading-5 text-white/55">Incluye sólo clase de dispositivo/navegador, visibilidad, permiso, red, Wake Lock, categoría HTTP y contadores. No incluye coordenadas, enlace, sesión ni tokens.</p><button type="button" onClick={() => void copyDiagnostic()} className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-white/15 text-sm font-semibold"><Copy size={16} />{diagnosticCopied ? 'DIAGNÓSTICO COPIADO' : 'COPIAR DIAGNÓSTICO'}</button></section> : null}
            <div className="mt-4 grid gap-2">
              <button type="button" onClick={() => void emitter.stopTransmission()} disabled={emitter.state === 'revoked' || emitter.state === 'expired'} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-white text-sm font-semibold text-black disabled:opacity-40"><ShieldAlert size={16} />DETENER Y REVOCAR ENLACE</button>
              <button type="button" onClick={() => void emitter.rotateViewer()} disabled={emitter.state !== 'active' && emitter.state !== 'paused'} className="flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-white/15 text-sm font-semibold disabled:opacity-40"><RotateCcw size={16} />ROTAR ENLACE</button>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
