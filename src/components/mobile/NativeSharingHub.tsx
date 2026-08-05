'use client'

import { useState } from 'react'
import { ChevronLeft, Cookie, Link2, Radio } from 'lucide-react'
import { parseViewerCapabilityValue, viewerFragmentLink } from '@/lib/location-source/native-sharing-api'
import CookieSessionPanel from './CookieSessionPanel'

interface NativeSharingHubProps {
  onBack: () => void
}

export default function NativeSharingHub({ onBack }: NativeSharingHubProps) {
  const [opening, setOpening] = useState(false)
  const [cookieMode, setCookieMode] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (cookieMode) return <CookieSessionPanel onBack={() => setCookieMode(false)} />

  const openLink = () => {
    const parsed = parseViewerCapabilityValue(value)
    if (!parsed) {
      setError('Pegá un enlace privado válido de STRACKER.')
      return
    }
    window.location.assign(viewerFragmentLink(parsed.capability))
  }

  return (
    <main data-native-sharing-hub="true" className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-x-hidden bg-black px-4 py-[max(72px,env(safe-area-inset-top))] text-white">
      <button type="button" onClick={onBack} aria-label="Volver" className="absolute left-3 top-[max(12px,env(safe-area-inset-top))] grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-white/[0.04]"><ChevronLeft size={22} /></button>
      <div className="w-full max-w-md">
        <header className="mb-7 text-center">
          <p className="text-xs font-semibold tracking-[0.2em] text-white/45">UBICACIÓN COMPARTIDA</p>
          <h1 className="mt-3 text-2xl font-semibold">Elegí cómo continuar</h1>
        </header>
        <div className="grid gap-3">
          <button type="button" onClick={() => setOpening((current) => !current)} className="flex min-h-[92px] items-center gap-4 rounded-[24px] border border-white/10 bg-white/[0.035] p-4 text-left">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white text-black"><Link2 size={23} /></span>
            <span><strong className="block">ABRIR ENLACE STRACKER</strong><span className="mt-1 block text-sm text-white/55">Ver una ubicación que te compartieron.</span></span>
          </button>
          {opening ? (
            <div className="rounded-[22px] border border-white/10 p-3">
              <label htmlFor="viewer-link" className="text-xs font-semibold text-white/50">ENLACE PRIVADO</label>
              <input id="viewer-link" value={value} onChange={(event) => { setValue(event.target.value); setError(null) }} autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="https://…/shared#v=…" className="mt-2 min-h-12 w-full rounded-2xl border border-white/10 bg-black px-3 text-sm" />
              {error ? <p role="alert" className="mt-2 text-xs text-white/65">{error}</p> : null}
              <button type="button" onClick={openLink} className="mt-3 min-h-11 w-full rounded-2xl bg-white text-sm font-semibold text-black">ABRIR</button>
            </div>
          ) : null}
          <button type="button" onClick={() => window.location.assign('/share')} className="flex min-h-[92px] items-center gap-4 rounded-[24px] border border-white/10 bg-white/[0.035] p-4 text-left">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-white/15"><Radio size={23} /></span>
            <span><strong className="block">COMPARTIR MI UBICACIÓN</strong><span className="mt-1 block text-sm text-white/55">Crear un enlace temporal y revocable.</span></span>
          </button>
          <button type="button" onClick={() => setCookieMode(true)} data-testid="open-cookie-session" className="flex min-h-[92px] items-center gap-4 rounded-[24px] border border-white/10 bg-white/[0.035] p-4 text-left">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-white/15"><Cookie size={23} /></span>
            <span><strong className="block">SESIÓN DE GOOGLE MAPS</strong><span className="mt-1 block text-sm text-white/55">Importar una sesión autorizada, temporal y sólo en memoria.</span></span>
          </button>
        </div>
        <p className="mt-5 text-center text-xs leading-5 text-white/35">STRACKER no consulta estados, puntos, mapas ni cookies hasta que elegís una acción explícita.</p>
      </div>
    </main>
  )
}
