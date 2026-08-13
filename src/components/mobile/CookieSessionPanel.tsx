'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ClipboardPaste, Cookie, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react'
import type { GhostRailSegment, LocationSample, LocationSnapshot } from '@/lib/location-source/contracts'
import {
  initialLocationPipelineState,
  processLocationSample,
  recordPipelineError,
  refreshPipelineTime,
  type LocationPipelineState,
} from '@/lib/location-source/location-pipeline'
import {
  CookieSessionApiError,
  deleteCookieSession,
  detectedCookieFormat,
  importCookieSession,
  readCookieSession,
  readCookieSessionPoint,
  refreshCookieSession,
  type CookieSessionPoint,
  type CookieSessionStatus,
} from '@/lib/location-source/cookie-session-api'
import {
  clearPersistedCookieSessionHandle,
  persistCookieSessionHandle,
  readPersistedCookieSessionHandle,
} from '@/lib/location-source/cookie-session-recovery'

const MobileMapShell = dynamic(() => import('./MobileMapShell'), { ssr: false })
const REFRESH_INTERVAL_MS = 20_000
const TRANSIENT_CODES = new Set(['COOKIE_PROVIDER_UNAVAILABLE', 'OPERATION_TIMEOUT', 'REQUEST_FAILED', 'FREQUENCY_LIMIT', 'STORAGE_UNAVAILABLE'])
interface CookieSessionAuthHandle { sessionId: string; ownerToken: string }
let activeCookieHandle: CookieSessionAuthHandle | null = null

interface CookieSessionPanelProps { onBack: () => void }
interface CapturedCookieInput { format: string; bytes: number }

const ERROR_COPY: Record<string, string> = {
  COOKIE_FORMAT_UNRECOGNIZED: 'Formato no reconocido. Usá Cookie Editor JSON, Cookie Header o Netscape cookies.txt.',
  COOKIE_INVALID: 'La exportación contiene una cookie inválida. Volvé a exportarla sin editarla.',
  COOKIE_DOMAIN_REJECTED: 'La exportación contiene dominios ajenos a Google. Importá únicamente cookies de google.com.',
  COOKIE_SET_INCOMPLETE: 'La exportación no contiene el mínimo de autenticación necesario. Exportá nuevamente la sesión completa.',
  COOKIE_EXPIRED: 'La sesión importada ya no contiene autenticación vigente. Exportá cookies nuevas.',
  COOKIE_AUTH_EXPIRED: 'Google dejó de aceptar esta sesión. Exportá cookies nuevas.',
  COOKIE_PROVIDER_UNAVAILABLE: 'Google no está disponible temporalmente. STRACKER conservará la sesión y reintentará.',
  COOKIE_SESSION_EXPIRED: 'La sesión temporal de STRACKER venció. Importala nuevamente.',
  BODY_TOO_LARGE: 'El archivo supera el límite permitido de 64 KiB.',
  FREQUENCY_LIMIT: 'La actualización fue demasiado rápida. STRACKER reintentará.',
  OPERATION_TIMEOUT: 'La validación tardó demasiado. STRACKER conservará la sesión y reintentará.',
  STORAGE_UNAVAILABLE: 'El almacenamiento temporal no respondió. STRACKER conservará el handle de esta pestaña y reintentará.',
  REQUEST_FAILED: 'No se pudo completar la operación.',
}

function message(error: unknown): string {
  if (error instanceof CookieSessionApiError) return ERROR_COPY[error.code] || 'El servidor rechazó la sesión de forma segura.'
  if (error instanceof DOMException && error.name === 'AbortError') return ''
  return 'No se pudo completar la operación. Revisá la conexión; la sesión no se borra por este error.'
}

function sessionState(status: CookieSessionStatus): 'active' | 'stale' {
  return status.state === 'ready' ? 'active' : 'stale'
}

function statusLabel(status: CookieSessionStatus): string {
  return status.state === 'ready' ? 'SESIÓN VALIDADA · UBICACIÓN DISPONIBLE' : 'SESIÓN VALIDADA · SIN UBICACIÓN ACTIVA'
}

export default function CookieSessionPanel({ onBack }: CookieSessionPanelProps) {
  const [captured, setCaptured] = useState<CapturedCookieInput | null>(null)
  const [handle, setHandle] = useState<CookieSessionAuthHandle | null>(() => activeCookieHandle)
  const [status, setStatus] = useState<CookieSessionStatus | null>(null)
  const [mapSnapshot, setMapSnapshot] = useState<LocationSnapshot | null>(null)
  const [ghostrail, setGhostrail] = useState<GhostRailSegment[]>([])
  const [busy, setBusy] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rawRef = useRef('')
  const controllerRef = useRef<AbortController | null>(null)
  const handleRef = useRef<CookieSessionAuthHandle | null>(activeCookieHandle)
  const pipelineRef = useRef<LocationPipelineState>(initialLocationPipelineState('shared-location'))

  useEffect(() => { handleRef.current = handle }, [handle])

  const clearCaptured = useCallback(() => {
    rawRef.current = ''
    setCaptured(null)
  }, [])

  const resetPipeline = useCallback(() => {
    pipelineRef.current = initialLocationPipelineState('shared-location', pipelineRef.current.sessionEpoch + 1)
    setMapSnapshot(null)
    setGhostrail([])
  }, [])

  const capture = useCallback((value: string) => {
    const bytes = new TextEncoder().encode(value).byteLength
    rawRef.current = value
    setCaptured(value.trim() ? { format: detectedCookieFormat(value), bytes } : null)
    setError(null)
  }, [])

  const applyPoint = useCallback((nextStatus: CookieSessionStatus, point: CookieSessionPoint | null) => {
    setStatus(nextStatus)
    if (!point) return
    const sample: LocationSample = {
      source: 'shared-location',
      lat: point.lat,
      lng: point.lng,
      accuracyM: point.accuracyM,
      capturedAt: point.capturedAt,
      receivedAt: nextStatus.validatedAt,
      speedMps: null,
      headingDeg: null,
    }
    const result = processLocationSample(pipelineRef.current, sample, sessionState(nextStatus))
    pipelineRef.current = result.state
    setMapSnapshot(result.snapshot)
    setGhostrail(result.ghostrail)
  }, [])

  const clearLocalSession = useCallback(() => {
    handleRef.current = null
    activeCookieHandle = null
    clearPersistedCookieSessionHandle()
    setHandle(null)
    setStatus(null)
    resetPipeline()
  }, [resetPipeline])

  const clearServerSession = useCallback(async () => {
    const current = handleRef.current
    controllerRef.current?.abort()
    controllerRef.current = null
    clearLocalSession()
    clearCaptured()
    setError(null)
    if (current) await deleteCookieSession(current as Parameters<typeof deleteCookieSession>[0]).catch(() => undefined)
  }, [clearCaptured, clearLocalSession])

  const loadCurrent = useCallback(async (current: CookieSessionAuthHandle, refresh: boolean) => {
    if (!navigator.onLine) {
      pipelineRef.current = recordPipelineError(pipelineRef.current)
      setMapSnapshot(pipelineRef.current.latest)
      setGhostrail(pipelineRef.current.rail.segments)
      setError('Sin conexión. La sesión sigue activa y se recuperará al volver la red.')
      return
    }
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const next = refresh
        ? await refreshCookieSession(current as Parameters<typeof refreshCookieSession>[0], controller.signal)
        : await readCookieSession(current as Parameters<typeof readCookieSession>[0], controller.signal)
      const location = next.locationAvailable ? await readCookieSessionPoint(current as Parameters<typeof readCookieSessionPoint>[0], controller.signal) : null
      applyPoint(next, location?.point ?? null)
      setError(null)
    } catch (caught) {
      const copy = message(caught)
      if (copy) setError(copy)
      if (caught instanceof CookieSessionApiError && ['COOKIE_AUTH_EXPIRED', 'COOKIE_SESSION_EXPIRED', 'NOT_FOUND'].includes(caught.code)) {
        clearLocalSession()
        return
      }
      pipelineRef.current = recordPipelineError(pipelineRef.current)
      setMapSnapshot(pipelineRef.current.latest)
      setGhostrail(pipelineRef.current.rail.segments)
    }
  }, [applyPoint, clearLocalSession])

  useEffect(() => {
    if (handleRef.current) return
    const recovered = readPersistedCookieSessionHandle()
    if (!recovered) return
    activeCookieHandle = { sessionId: recovered.sessionId, ownerToken: recovered.ownerToken }
    handleRef.current = activeCookieHandle
    setHandle(activeCookieHandle)
    setRecovering(true)
    void loadCurrent(activeCookieHandle, false).finally(() => setRecovering(false))
  }, [loadCurrent])

  useEffect(() => () => {
    controllerRef.current?.abort()
    controllerRef.current = null
  }, [])

  useEffect(() => {
    if (!handle) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const schedule = () => {
      if (stopped) return
      timer = setTimeout(async () => {
        const current = handleRef.current
        if (current && navigator.onLine && document.visibilityState === 'visible') await loadCurrent(current, true)
        schedule()
      }, REFRESH_INTERVAL_MS)
    }
    const online = () => { const current = handleRef.current; if (current) void loadCurrent(current, true) }
    const visible = () => { const current = handleRef.current; if (current && document.visibilityState === 'visible') void loadCurrent(current, true) }
    const pageshow = () => { const current = handleRef.current; if (current) void loadCurrent(current, false) }
    schedule()
    window.addEventListener('online', online)
    window.addEventListener('pageshow', pageshow)
    document.addEventListener('visibilitychange', visible)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      window.removeEventListener('online', online)
      window.removeEventListener('pageshow', pageshow)
      document.removeEventListener('visibilitychange', visible)
      controllerRef.current?.abort()
    }
  }, [handle, loadCurrent])

  useEffect(() => {
    if (!handle) return
    const timer = setInterval(() => {
      pipelineRef.current = refreshPipelineTime(pipelineRef.current, status ? sessionState(status) : 'stale')
      setMapSnapshot(pipelineRef.current.latest)
      setGhostrail(pipelineRef.current.rail.segments)
    }, 1_000)
    return () => clearInterval(timer)
  }, [handle, status])

  const submit = async () => {
    if (!rawRef.current.trim() || busy) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(true)
    setError(null)
    try {
      const imported = await importCookieSession(rawRef.current, controller.signal)
      clearCaptured()
      resetPipeline()
      const auth = { sessionId: imported.sessionId, ownerToken: imported.ownerToken }
      activeCookieHandle = auth
      handleRef.current = auth
      setHandle(auth)
      persistCookieSessionHandle(auth, imported.expiresAt)
      const location = imported.locationAvailable ? await readCookieSessionPoint(auth as Parameters<typeof readCookieSessionPoint>[0], controller.signal) : null
      applyPoint(imported, location?.point ?? null)
    } catch (caught) {
      const copy = message(caught)
      if (copy) setError(copy)
      if (caught instanceof CookieSessionApiError && !TRANSIENT_CODES.has(caught.code)) clearCaptured()
    } finally {
      setBusy(false)
    }
  }

  const paste = async () => {
    setError(null)
    if (!navigator.clipboard?.readText) {
      setError('El navegador no permite leer el portapapeles. Pegá directamente dentro del campo seguro.')
      return
    }
    try { capture(await navigator.clipboard.readText()) }
    catch { setError('Chrome bloqueó el portapapeles. Pegá directamente dentro del campo seguro.') }
  }

  const leave = () => {
    controllerRef.current?.abort()
    controllerRef.current = null
    onBack()
  }

  if (mapSnapshot && handle) {
    return <MobileMapShell source="shared-location" snapshot={mapSnapshot} ghostrail={ghostrail} onChangeSource={leave} onStop={() => { void clearServerSession() }} />
  }

  return (
    <main data-cookie-session-panel="true" className="relative min-h-[100dvh] w-full overflow-x-hidden bg-black px-4 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(72px,env(safe-area-inset-top))] text-white">
      <button type="button" onClick={leave} aria-label="Volver" className="absolute left-3 top-[max(12px,env(safe-area-inset-top))] grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-white/[0.04]"><ChevronLeft size={22} /></button>
      <section className="mx-auto w-full max-w-2xl" aria-labelledby="cookie-session-title">
        <header className="mb-6 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-white/15"><Cookie size={23} /></div>
          <p className="mt-4 text-xs font-semibold tracking-[0.18em] text-white/45">UBICACIÓN COMPARTIDA</p>
          <h1 id="cookie-session-title" className="mt-2 text-2xl font-semibold">Sesión autorizada de Google Maps</h1>
        </header>
        <div role="note" className="rounded-[20px] border border-amber-300/20 bg-amber-300/[0.07] p-4 text-sm leading-6 text-amber-100">
          <div className="flex gap-3"><ShieldAlert className="mt-0.5 shrink-0" size={20} /><p><strong>Las cookies son credenciales sensibles.</strong> No compartas sus valores en capturas, chats, logs o reportes. STRACKER las cifra antes de persistirlas temporalmente en el servidor y nunca las guarda en storage del navegador.</p></div>
        </div>

        {!handle ? (
          <div className="mt-5">
            <div className="flex items-center justify-between gap-3"><label htmlFor="cookie-session-source" className="text-sm font-semibold">Exportación de cookies</label><button type="button" onClick={() => { void paste() }} data-testid="cookie-paste" className="flex min-h-11 items-center gap-2 rounded-xl border border-white/12 px-3 text-sm"><ClipboardPaste size={17} />PEGAR</button></div>
            <textarea id="cookie-session-source" data-testid="cookie-capture" value="" onChange={() => undefined} onPaste={(event) => { event.preventDefault(); capture(event.clipboardData.getData('text')) }} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="Pegá acá. STRACKER captura el contenido sin volver a mostrar sus valores." className="mt-3 min-h-[132px] max-h-[30dvh] w-full resize-y rounded-[20px] border border-white/12 bg-white/[0.035] p-4 text-sm leading-6 outline-none focus:border-white/35" />
            <div data-testid="cookie-capture-metadata" className="mt-3 rounded-2xl border border-white/8 bg-white/[0.025] p-3 text-xs leading-5 text-white/55"><p><strong className="text-white/75">Captura:</strong> {captured ? 'lista y oculta' : 'sin datos'}</p><p className="mt-1"><strong className="text-white/75">Formato detectado:</strong> {captured?.format ?? 'Sin detectar'}</p><p className="mt-1"><strong className="text-white/75">Tamaño:</strong> {captured ? `${captured.bytes} bytes` : '—'}</p><p className="mt-1">Los valores crudos no se reflejan en pantalla ni se guardan en almacenamiento del navegador.</p></div>
            {error ? <p data-testid="cookie-error" role="alert" className="mt-3 rounded-2xl border border-red-300/20 bg-red-300/[0.07] p-3 text-sm leading-5 text-red-100">{error}</p> : null}
            <div className="mt-4 grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => { clearCaptured(); setError(null) }} data-testid="cookie-clear" className="min-h-12 rounded-2xl border border-white/12 text-sm font-semibold">LIMPIAR</button><button type="button" onClick={() => { void submit() }} disabled={!captured || busy} data-testid="cookie-import" className="min-h-12 rounded-2xl bg-white text-sm font-semibold text-black disabled:opacity-40">{busy ? 'VALIDANDO EN EL SERVIDOR…' : 'IMPORTAR Y VALIDAR'}</button></div>
          </div>
        ) : (
          <div data-testid="cookie-success" className="mt-5 rounded-[22px] border border-emerald-300/20 bg-emerald-300/[0.06] p-4">
            <p className="text-sm font-semibold text-emerald-100">{recovering ? 'RECUPERANDO SESIÓN DE ESTA PESTAÑA…' : status ? statusLabel(status) : 'SESIÓN TEMPORAL DISPONIBLE'}</p>
            <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-white/45">Persistencia</dt><dd>Memoria temporal + respaldo cifrado del DO</dd></div><div><dt className="text-white/45">Formato</dt><dd>{status?.format ?? '—'}</dd></div><div><dt className="text-white/45">Cantidad retenida</dt><dd>{status?.cookieCount ?? 0}</dd></div><div><dt className="text-white/45">Vence</dt><dd>{status ? new Date(status.expiresAt).toLocaleString('es-AR') : '—'}</dd></div></dl>
            <p className="mt-4 text-xs leading-5 text-white/50">Cambiar de pestaña, volver al hub, recargar esta pestaña, cambiar 3D/Satélite/Híbrido o reconstruir el Durable Object no cierra la sesión. BORRAR SESIÓN, DETENER, vencimiento real o rechazo de autenticación sí la revocan.</p>
            {status?.state === 'no_location' ? <p role="status" className="mt-4 rounded-xl border border-white/10 p-3 text-sm text-white/65">La autenticación fue aceptada, pero Google no devuelve una ubicación compartida activa.</p> : null}
            {error ? <p role="alert" className="mt-3 rounded-xl border border-red-300/20 p-3 text-sm text-red-100">{error}</p> : null}
            <div className="mt-4 grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => { const current = handleRef.current; if (current) void loadCurrent(current, true) }} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-white/12 text-sm font-semibold"><RefreshCw size={17} />ACTUALIZAR</button><button type="button" onClick={() => { void clearServerSession() }} data-testid="cookie-delete" className="flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-white/12 text-sm font-semibold"><Trash2 size={17} />BORRAR SESIÓN</button></div>
          </div>
        )}
      </section>
    </main>
  )
}
