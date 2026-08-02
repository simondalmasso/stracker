'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import { ChevronLeft, Copy, Eye, ShieldCheck, Wifi, WifiOff } from 'lucide-react'
import { useNativeViewer } from '@/lib/location-source/use-native-viewer'

const MobileMapShell = dynamic(() => import('./MobileMapShell'), { ssr: false })

function stateLabel(state: string): string {
  return ({
    unconfirmed: 'SIN CONFIRMAR',
    validating: 'VALIDANDO',
    active: 'SESIÓN ACTIVA',
    stale: 'CON DATOS DEMORADOS',
    expired: 'VENCIDA',
    revoked: 'REVOCADA',
    invalid: 'INVÁLIDA',
  } as Record<string, string>)[state] || state.toUpperCase()
}

function freshnessLabel(value: string): string {
  return ({
    fresh: 'ACTUALIZADA · 0–15S',
    delayed: 'DEMORADA · 16–45S',
    stale: 'DESACTUALIZADA · MÁS DE 45S',
    expired: 'VENCIDA',
    unknown: 'SIN PUNTO CONFIRMADO',
  } as Record<string, string>)[value] || 'SIN DATO'
}

function connectionLabel(value: string): string {
  return ({
    online: 'CONECTADA',
    offline: 'SIN CONEXIÓN',
    sending: 'CONSULTANDO',
    recovering: 'RECUPERANDO',
    error: 'REQUIERE ACCIÓN',
  } as Record<string, string>)[value] || value.toUpperCase()
}

function ageText(capturedAt: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(capturedAt)) / 1000))
  return seconds < 5 ? 'AHORA' : `HACE ${seconds}S`
}

export default function NativeViewerApp() {
  const viewer = useNativeViewer()
  const [diagnosticCopied, setDiagnosticCopied] = useState(false)

  const close = () => {
    viewer.stop()
    window.location.assign('/')
  }

  const copyDiagnostic = async () => {
    await navigator.clipboard.writeText(await viewer.getDiagnostic())
    setDiagnosticCopied(true)
    window.setTimeout(() => setDiagnosticCopied(false), 1500)
  }

  if (viewer.snapshot && (viewer.state === 'active' || viewer.state === 'stale')) {
    const mapSnapshot = viewer.snapshot.freshness === 'delayed'
      ? { ...viewer.snapshot, freshness: 'fresh' as const }
      : viewer.snapshot
    return (
      <div className="relative h-[100dvh] w-full overflow-hidden bg-black" data-pilot-freshness={viewer.freshnessState} data-pilot-network={viewer.networkState}>
        <MobileMapShell source="shared-location" snapshot={mapSnapshot} ghostrail={viewer.ghostrail} onChangeSource={close} onStop={close} />
        <section className="pointer-events-none absolute inset-x-3 top-[calc(max(12px,env(safe-area-inset-top))+52px)] z-[540] rounded-2xl border border-white/10 bg-black/90 px-3 py-2 text-white shadow-lg backdrop-blur-xl" aria-label="Frescura y conexión del visor">
          <div className="flex items-center justify-between gap-3 text-[11px] font-semibold">
            <span>{freshnessLabel(viewer.freshnessState)}</span>
            <span className="flex items-center gap-1.5">{viewer.networkState === 'offline' ? <WifiOff size={13} /> : <Wifi size={13} />}{connectionLabel(viewer.networkState)}</span>
          </div>
          <p className="mt-1 text-[11px] text-white/55">ÚLTIMO PUNTO {ageText(viewer.snapshot.capturedAt)} · no se presenta como ubicación en vivo garantizada</p>
        </section>
      </div>
    )
  }

  const showDiagnostic = Boolean(viewer.error) || viewer.networkState === 'offline' || viewer.networkState === 'recovering' || viewer.networkState === 'error'

  return (
    <main className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-x-hidden bg-black px-5 text-white" data-viewer-state={viewer.state} data-network-state={viewer.networkState} data-analytics="off">
      <button type="button" onClick={close} aria-label="Volver" className="absolute left-3 top-[max(12px,env(safe-area-inset-top))] grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-white/[0.04]"><ChevronLeft size={22} /></button>
      <div className="w-full max-w-sm text-center">
        <Eye className="mx-auto" size={34} />
        <p className="mt-5 text-xs font-semibold tracking-[0.18em] text-white/45">STRACKER</p>
        <h1 className="mt-2 text-2xl font-semibold">Te compartieron una ubicación</h1>
        {viewer.state === 'unconfirmed' ? (
          <>
            <p className="mt-3 text-sm leading-6 text-white/55">El enlace no consulta estado, puntos, intercambio ni mapa hasta que confirmes.</p>
            <button type="button" onClick={() => void viewer.start()} className="mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white text-sm font-semibold text-black"><ShieldCheck size={18} />VER UBICACIÓN</button>
          </>
        ) : (
          <>
            <div className="mt-5 rounded-2xl border border-white/10 p-4 text-left">
              <p className="text-xs text-white/45">ESTADO</p>
              <p className="mt-1 font-semibold">{stateLabel(viewer.state)}</p>
              <p className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-white/70">{viewer.networkState === 'offline' ? <WifiOff size={14} /> : <Wifi size={14} />}{connectionLabel(viewer.networkState)}</p>
              <p className="mt-3 text-sm leading-6 text-white/55">{viewer.loading ? 'Validando el enlace privado…' : viewer.error || 'La sesión es válida, pero todavía no recibió un punto confirmado.'}</p>
            </div>
            {showDiagnostic ? <button type="button" onClick={() => void copyDiagnostic()} className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-white/15 text-sm font-semibold"><Copy size={16} />{diagnosticCopied ? 'DIAGNÓSTICO COPIADO' : 'COPIAR DIAGNÓSTICO SEGURO'}</button> : null}
            {(viewer.state === 'invalid' || viewer.state === 'expired' || viewer.state === 'revoked') ? <button type="button" onClick={close} className="mt-4 min-h-11 w-full rounded-2xl border border-white/15 text-sm font-semibold">CERRAR</button> : null}
          </>
        )}
        <p className="mt-5 text-xs leading-5 text-white/35">La capacidad original se intercambia una sola vez, se elimina del fragmento y nunca se reutiliza para polling.</p>
      </div>
    </main>
  )
}
