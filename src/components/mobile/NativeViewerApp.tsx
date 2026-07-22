'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import { ChevronLeft, Eye, ShieldCheck } from 'lucide-react'
import { useNativeViewer } from '@/lib/location-source/use-native-viewer'

const MobileMapShell = dynamic(() => import('./MobileMapShell'), { ssr: false })

function stateLabel(state: string): string {
  return ({
    unconfirmed: 'SIN CONFIRMAR',
    validating: 'VALIDANDO',
    active: 'ACTIVA',
    stale: 'STALE',
    expired: 'VENCIDA',
    revoked: 'REVOCADA',
    invalid: 'INVÁLIDA',
  } as Record<string, string>)[state] || state.toUpperCase()
}

function capabilityFromPath(initialCapability: string): string {
  if (initialCapability) return initialCapability
  if (typeof window === 'undefined') return ''
  return /^\/shared\/([^/]+)\/?$/.exec(window.location.pathname)?.[1] || ''
}

export default function NativeViewerApp({ initialCapability = '' }: { initialCapability?: string }) {
  const viewer = useNativeViewer()
  const [capability] = useState(() => capabilityFromPath(initialCapability))

  const close = () => {
    viewer.stop()
    window.location.assign('/')
  }

  if (viewer.snapshot && (viewer.state === 'active' || viewer.state === 'stale')) {
    return <MobileMapShell source="shared-location" snapshot={viewer.snapshot} ghostrail={viewer.ghostrail} onChangeSource={close} onStop={close} />
  }

  return (
    <main className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-x-hidden bg-black px-5 text-white" data-viewer-state={viewer.state}>
      <button type="button" onClick={close} aria-label="Volver" className="absolute left-3 top-[max(12px,env(safe-area-inset-top))] grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-white/[0.04]"><ChevronLeft size={22} /></button>
      <div className="w-full max-w-sm text-center">
        <Eye className="mx-auto" size={34} />
        <p className="mt-5 text-xs font-semibold tracking-[0.18em] text-white/45">STRACKER</p>
        <h1 className="mt-2 text-2xl font-semibold">Te compartieron una ubicación</h1>
        {viewer.state === 'unconfirmed' ? (
          <>
            <p className="mt-3 text-sm leading-6 text-white/55">El enlace no consulta estado, puntos ni mapa hasta que confirmes.</p>
            <button type="button" onClick={() => void viewer.start(capability)} className="mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-white text-sm font-semibold text-black"><ShieldCheck size={18} />VER UBICACIÓN</button>
          </>
        ) : (
          <>
            <div className="mt-5 rounded-2xl border border-white/10 p-4 text-left">
              <p className="text-xs text-white/45">ESTADO</p>
              <p className="mt-1 font-semibold">{stateLabel(viewer.state)}</p>
              <p className="mt-3 text-sm leading-6 text-white/55">{viewer.loading ? 'Consultando la sesión privada…' : viewer.error || 'La sesión es válida, pero todavía no recibió un punto confirmado.'}</p>
            </div>
            {(viewer.state === 'invalid' || viewer.state === 'expired' || viewer.state === 'revoked') ? <button type="button" onClick={close} className="mt-4 min-h-11 w-full rounded-2xl border border-white/15 text-sm font-semibold">CERRAR</button> : null}
          </>
        )}
        <p className="mt-5 text-xs leading-5 text-white/35">Una ubicación stale o expirada nunca se presenta como LIVE.</p>
      </div>
    </main>
  )
}
