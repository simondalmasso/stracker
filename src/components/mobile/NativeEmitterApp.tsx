'use client'

import { useMemo, useState } from 'react'
import { ChevronLeft, Copy, Link2, Radio, RotateCcw, ShieldAlert, Square } from 'lucide-react'
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
  if (!value) return 'SIN DATOS'
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000))
  return seconds < 5 ? 'AHORA' : `HACE ${seconds}S`
}

export default function NativeEmitterApp() {
  const emitter = useNativeEmitter()
  const [durationMs, setDurationMs] = useState(DURATIONS[1].ms)
  const [copied, setCopied] = useState(false)
  const link = useMemo(() => {
    if (!emitter.session) return null
    const origin = typeof window === 'undefined' ? '' : window.location.origin
    return `${origin}/shared/${emitter.session.viewerCapability}`
  }, [emitter.session])
  const started = emitter.state !== 'not-started' && emitter.state !== 'requesting-permission' && emitter.session !== null

  const copy = async () => {
    if (!link) return
    await navigator.clipboard.writeText(link)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <main className="relative min-h-[100dvh] overflow-x-hidden bg-black px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-[max(76px,calc(env(safe-area-inset-top)+64px))] text-white" data-sharing-state={emitter.state}>
      <button type="button" onClick={() => window.location.assign('/')} aria-label="Volver" className="absolute left-3 top-[max(12px,env(safe-area-inset-top))] grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-white/[0.04]"><ChevronLeft size={22} /></button>
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
              <div><p className="text-xs font-semibold text-white/45">LIMITACIONES EN SEGUNDO PLANO</p><p className="mt-1 text-white/75">El navegador puede pausar la transmisión con la pantalla bloqueada, suspendido o cerrado.</p></div>
            </section>
            {emitter.error ? <p role="alert" className="mt-3 rounded-2xl border border-white/10 p-4 text-sm">{emitter.error}</p> : null}
            <button type="button" disabled={emitter.state === 'requesting-permission'} onClick={() => emitter.start(durationMs)} className="mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white text-sm font-semibold text-black disabled:opacity-50"><Radio size={18} />{emitter.state === 'requesting-permission' ? 'SOLICITANDO PERMISO…' : 'INICIAR TRANSMISIÓN'}</button>
            <p className="mt-4 text-center text-xs leading-5 text-white/35">La geolocalización no se solicita antes de este botón.</p>
          </>
        ) : (
          <>
            <section className="mt-6 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-2xl border border-white/10 p-3"><p className="text-white/45">ESTADO</p><p className="mt-1 font-semibold">{emitter.state.toUpperCase()}</p></div>
              <div className="rounded-2xl border border-white/10 p-3"><p className="text-white/45">DURACIÓN RESTANTE</p><p className="mt-1 font-semibold">{durationText(emitter.remainingMs)}</p></div>
              <div className="col-span-2 rounded-2xl border border-white/10 p-3"><p className="text-white/45">ÚLTIMA ACTUALIZACIÓN</p><p className="mt-1 font-semibold">{updateText(emitter.lastUpdate)}</p></div>
            </section>
            {link ? (
              <section className="mt-3 rounded-[24px] border border-white/10 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold text-white/45"><Link2 size={15} />ENLACE PRIVADO</div>
                <input readOnly value={link} aria-label="Enlace privado de espectador" className="mt-3 min-h-12 w-full rounded-2xl border border-white/10 bg-black px-3 font-mono text-xs" />
                <button type="button" onClick={() => void copy()} className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl bg-white text-sm font-semibold text-black"><Copy size={17} />{copied ? 'COPIADO' : 'COPIAR ENLACE'}</button>
                <p className="mt-3 text-xs leading-5 text-white/40">El token de emisión permanece sólo en memoria y nunca forma parte del enlace.</p>
              </section>
            ) : null}
            {emitter.error ? <p role="alert" className="mt-3 rounded-2xl border border-white/10 p-4 text-sm">{emitter.error}</p> : null}
            <div className="mt-4 grid gap-2">
              <button type="button" onClick={emitter.stopTransmission} disabled={emitter.state === 'paused' || emitter.state === 'revoked' || emitter.state === 'expired'} className="flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-white/15 text-sm font-semibold disabled:opacity-40"><Square size={16} />DETENER</button>
              <button type="button" onClick={() => void emitter.rotateViewer()} disabled={emitter.state !== 'active' && emitter.state !== 'paused'} className="flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-white/15 text-sm font-semibold disabled:opacity-40"><RotateCcw size={16} />ROTAR ENLACE</button>
              <button type="button" onClick={() => void emitter.revoke()} disabled={emitter.state === 'revoked'} className="flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-white/20 text-sm font-semibold disabled:opacity-40"><ShieldAlert size={16} />REVOCAR ENLACE</button>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
