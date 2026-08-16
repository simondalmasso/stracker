'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ClipboardPaste, Cookie, History, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react'
import type { GhostRailSegment, LocationKeyframe, LocationSnapshot } from '@/lib/location-source/contracts'
import { freshnessFromTimestamp } from '@/lib/location-source/contracts'
import {
  CookieSessionApiError,
  clearCookieMobility,
  clearCookieSessionHandle,
  deleteCookieSession,
  detectedCookieFormat,
  importCookieSession,
  loadCookieSessionHandle,
  persistCookieSessionHandle,
  readCookieSession,
  readCookieSessionHistory,
  readCookieSessionPoint,
  refreshCookieSession,
  type CookieHistoryResponse,
  type CookieSessionHandle,
  type CookieSessionPoint,
  type CookieSessionStatus,
} from '@/lib/location-source/cookie-session-api'

const MobileMapShell = dynamic(() => import('./MobileMapShell'), { ssr: false })
const REFRESH_INTERVAL_MS = 20_000
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000
const TRANSIENT_CODES = new Set(['COOKIE_PROVIDER_UNAVAILABLE', 'OPERATION_TIMEOUT', 'REQUEST_FAILED', 'FREQUENCY_LIMIT'])

interface CookieSessionPanelProps { onBack: () => void }
interface CapturedCookieInput { format: string; bytes: number }

const ERROR_COPY: Record<string, string> = {
  COOKIE_FORMAT_UNRECOGNIZED: 'Formato no reconocido. Usá Cookie Editor JSON, Cookie Header o Netscape cookies.txt.',
  COOKIE_INVALID: 'La exportación contiene una fila crítica inválida. Volvé a exportarla sin editarla.',
  COOKIE_DOMAIN_REJECTED: 'La exportación contiene una cookie crítica fuera de google.com.',
  COOKIE_SET_INCOMPLETE: 'No queda autenticación suficiente para validar la sesión.',
  COOKIE_EXPIRED: 'La sesión importada ya no contiene autenticación vigente. Exportá cookies nuevas.',
  COOKIE_AUTH_EXPIRED: 'Google rechazó la autenticación o ya no queda una cookie de autenticación vigente.',
  COOKIE_PROVIDER_UNAVAILABLE: 'Google no está disponible temporalmente. STRACKER conserva la sesión cifrada y reintentará.',
  COOKIE_SESSION_EXPIRED: 'La sesión temporal de STRACKER venció. Importala nuevamente.',
  BODY_TOO_LARGE: 'El archivo supera el límite permitido de 64 KiB.',
  FREQUENCY_LIMIT: 'La actualización fue demasiado rápida. El sampler seguirá en segundo plano.',
  OPERATION_TIMEOUT: 'La validación tardó demasiado. STRACKER conserva la sesión para el próximo intento.',
  REQUEST_FAILED: 'No se pudo completar la operación.',
}

function message(error: unknown): string {
  if (error instanceof CookieSessionApiError) return ERROR_COPY[error.code] || 'El servidor rechazó la sesión de forma segura.'
  if (error instanceof DOMException && error.name === 'AbortError') return ''
  return 'No se pudo completar la operación. Revisá la conexión y reintentá.'
}

function snapshot(status: CookieSessionStatus, point: CookieSessionPoint | null): LocationSnapshot | null {
  if (!point) return null
  const freshness = freshnessFromTimestamp('shared-location', point.capturedAt)
  const terminated = status.state === 'auth_expired'
  return {
    source: 'shared-location', lat: point.lat, lng: point.lng, accuracyM: point.accuracyM, capturedAt: point.capturedAt,
    receivedAt: point.observedAt || status.validatedAt, speedMps: null, headingDeg: null, freshness,
    health: terminated || freshness === 'stale' || freshness === 'expired' ? 'degraded' : 'receiving',
    motion: 'unknown', viewerSession: terminated || freshness === 'stale' ? 'stale' : 'active', visualUpdated: true,
    filterDecision: 'accepted',
    filterReason: point.sourceQuality === 'provider_timestamp' ? 'cookie-provider-timestamped-observation' : 'cookie-provider-server-observation',
  }
}

function statusLabel(status: CookieSessionStatus): string {
  if (status.state === 'auth_expired') return 'AUTENTICACIÓN FINALIZADA · HISTORIA RETENIDA HASTA SU TTL'
  return status.state === 'ready' ? 'SESIÓN ACTIVA · CAPTURA DE SERVIDOR ENCENDIDA' : 'SESIÓN ACTIVA · ESPERANDO UBICACIÓN COMPARTIDA'
}

function ghostrail(history: CookieHistoryResponse | null): GhostRailSegment[] {
  if (!history) return []
  return history.segments.map((segment, index) => ({
    id: segment.id, source: 'shared-location', sessionEpoch: index, points: segment.points,
    startedAt: segment.startedAt, endedAt: segment.endedAt, provenance: segment.provenance,
    confidence: segment.confidence, method: segment.method,
  }))
}

function keyframes(history: CookieHistoryResponse | null): LocationKeyframe[] {
  if (!history) return []
  return history.keyframes.map((event) => ({
    id: event.id, type: event.type, at: event.at, lat: event.lat, lng: event.lng,
    provenance: event.provenance, confidence: event.confidence,
  }))
}

export default function CookieSessionPanel({ onBack }: CookieSessionPanelProps) {
  const [captured, setCaptured] = useState<CapturedCookieInput | null>(null)
  const [handle, setHandle] = useState<CookieSessionHandle | null>(null)
  const [status, setStatus] = useState<CookieSessionStatus | null>(null)
  const [point, setPoint] = useState<CookieSessionPoint | null>(null)
  const [history, setHistory] = useState<CookieHistoryResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rawRef = useRef('')
  const controllerRef = useRef<AbortController | null>(null)
  const handleRef = useRef<CookieSessionHandle | null>(null)

  useEffect(() => { handleRef.current = handle }, [handle])

  const clearCaptured = useCallback(() => { rawRef.current = ''; setCaptured(null) }, [])
  const capture = useCallback((value: string) => {
    const bytes = new TextEncoder().encode(value).byteLength
    rawRef.current = value
    setCaptured(value.trim() ? { format: detectedCookieFormat(value), bytes } : null)
    setError(null)
  }, [])

  const dropLocalHandle = useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
    handleRef.current = null
    clearCookieSessionHandle()
    setHandle(null); setStatus(null); setPoint(null); setHistory(null)
  }, [])

  const clearServerSession = useCallback(async () => {
    const current = handleRef.current
    dropLocalHandle(); clearCaptured(); setError(null)
    if (current) await deleteCookieSession(current).catch(() => undefined)
  }, [clearCaptured, dropLocalHandle])

  useEffect(() => () => { controllerRef.current?.abort(); controllerRef.current = null }, [])

  const hydrate = useCallback(async (current: CookieSessionHandle, refreshProvider: boolean) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      let transientCopy = ''
      let nextStatus: CookieSessionStatus | null = null
      if (refreshProvider && navigator.onLine && document.visibilityState === 'visible') {
        try {
          nextStatus = await refreshCookieSession(current, controller.signal)
        } catch (caught) {
          if (!(caught instanceof CookieSessionApiError) || !TRANSIENT_CODES.has(caught.code)) throw caught
          transientCopy = message(caught)
        }
      }
      const since = new Date(Date.now() - HISTORY_WINDOW_MS).toISOString()
      const [safeStatus, location, nextHistory] = await Promise.all([
        nextStatus ? Promise.resolve(nextStatus) : readCookieSession(current, controller.signal),
        readCookieSessionPoint(current, controller.signal),
        readCookieSessionHistory(current, since, controller.signal),
      ])
      const persisted = { ...current, ...safeStatus }
      persistCookieSessionHandle(persisted)
      handleRef.current = persisted
      setHandle(persisted); setStatus(safeStatus); setPoint(location.point); setHistory(nextHistory)
      if (safeStatus.state === 'auth_expired') setError(ERROR_COPY.COOKIE_AUTH_EXPIRED)
      else setError(transientCopy || null)
    } catch (caught) {
      const copy = message(caught)
      if (copy) setError(copy)
      if (caught instanceof CookieSessionApiError && ['COOKIE_SESSION_EXPIRED', 'NOT_FOUND'].includes(caught.code)) dropLocalHandle()
    }
  }, [dropLocalHandle])

  useEffect(() => {
    const restored = loadCookieSessionHandle()
    if (!restored) return
    handleRef.current = restored
    setHandle(restored); setStatus(restored)
    void hydrate(restored, false)
  }, [hydrate])

  const doRefresh = useCallback(async () => {
    const current = handleRef.current
    if (!current || !navigator.onLine || document.visibilityState !== 'visible') return
    await hydrate(current, true)
  }, [hydrate])

  useEffect(() => {
    if (!handle) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const schedule = () => {
      if (stopped) return
      timer = setTimeout(async () => { await doRefresh(); schedule() }, REFRESH_INTERVAL_MS)
    }
    const online = () => { void doRefresh() }
    const visible = () => { const current = handleRef.current; if (current && document.visibilityState === 'visible') void hydrate(current, false) }
    schedule()
    window.addEventListener('online', online)
    document.addEventListener('visibilitychange', visible)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      window.removeEventListener('online', online)
      document.removeEventListener('visibilitychange', visible)
      controllerRef.current?.abort()
    }
  }, [doRefresh, handle, hydrate])

  const submit = async () => {
    if (!rawRef.current.trim() || busy) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(true); setError(null)
    try {
      const imported = await importCookieSession(rawRef.current, controller.signal)
      clearCaptured()
      handleRef.current = imported
      setHandle(imported); setStatus(imported)
      await hydrate(imported, false)
    } catch (caught) {
      const copy = message(caught)
      if (copy) setError(copy)
      if (caught instanceof CookieSessionApiError && !TRANSIENT_CODES.has(caught.code)) clearCaptured()
    } finally { setBusy(false) }
  }

  const paste = async () => {
    setError(null)
    if (!navigator.clipboard?.readText) { setError('El navegador no permite leer el portapapeles. Pegá dentro del campo seguro con el menú del sistema.'); return }
    try { capture(await navigator.clipboard.readText()) } catch { setError('Chrome bloqueó el portapapeles. Pegá dentro del campo seguro con el menú del sistema.') }
  }

  const clearModel = async () => {
    const current = handleRef.current
    if (!current) return
    setBusy(true)
    try { await clearCookieMobility(current); setError(null); await hydrate(current, false) }
    catch (caught) { const copy = message(caught); if (copy) setError(copy) }
    finally { setBusy(false) }
  }

  const rail = useMemo(() => ghostrail(history), [history])
  const events = useMemo(() => keyframes(history), [history])
  const mapSnapshot = useMemo(() => status ? snapshot(status, point) : null, [point, status])
  if (mapSnapshot && handle) return <MobileMapShell source="shared-location" snapshot={mapSnapshot} ghostrail={rail} keyframes={events} onChangeSource={onBack} onStop={() => { void clearServerSession() }} />

  return (
    <main data-cookie-session-panel="true" className="relative min-h-[100dvh] w-full overflow-x-hidden bg-black px-4 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(72px,env(safe-area-inset-top))] text-white">
      <button type="button" onClick={onBack} aria-label="Volver" className="absolute left-3 top-[max(12px,env(safe-area-inset-top))] grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-white/[0.04]"><ChevronLeft size={22} /></button>
      <section className="mx-auto w-full max-w-2xl" aria-labelledby="cookie-session-title">
        <header className="mb-6 text-center"><div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-white/15"><Cookie size={23} /></div><p className="mt-4 text-xs font-semibold tracking-[0.18em] text-white/45">UBICACIÓN COMPARTIDA</p><h1 id="cookie-session-title" className="mt-2 text-2xl font-semibold">Sesión autorizada de Google Maps</h1></header>
        <div role="note" className="rounded-[20px] border border-amber-300/20 bg-amber-300/[0.07] p-4 text-sm leading-6 text-amber-100"><div className="flex gap-3"><ShieldAlert className="mt-0.5 shrink-0" size={20} /><p><strong>Las cookies son credenciales sensibles.</strong> STRACKER no las refleja en pantalla ni las guarda en el navegador. En servidor sólo persiste una copia cifrada y con TTL.</p></div></div>
        {!handle ? (
          <div className="mt-5">
            <div className="flex items-center justify-between gap-3"><label htmlFor="cookie-session-source" className="text-sm font-semibold">Exportación de cookies</label><button type="button" onClick={() => { void paste() }} data-testid="cookie-paste" className="flex min-h-11 items-center gap-2 rounded-xl border border-white/12 px-3 text-sm"><ClipboardPaste size={17} />PEGAR</button></div>
            <textarea id="cookie-session-source" data-testid="cookie-textarea" value="" onPaste={(event) => { event.preventDefault(); capture(event.clipboardData.getData('text')) }} onChange={(event) => capture(event.currentTarget.value)} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={64 * 1024} placeholder="Pegá acá Cookie Editor JSON, Cookie Header o Netscape cookies.txt" className="mt-3 min-h-[150px] max-h-[38dvh] w-full resize-y rounded-[20px] border border-white/12 bg-white/[0.035] p-4 font-mono text-sm leading-6 outline-none focus:border-white/35" />
            <div className="mt-3 rounded-2xl border border-white/8 bg-white/[0.025] p-3 text-xs leading-5 text-white/55"><p><strong className="text-white/75">Captura segura:</strong> {captured ? `${captured.format} · ${captured.bytes} bytes capturados` : 'sin contenido'}</p><p className="mt-1">El valor pegado nunca se vuelve a dibujar. Sólo se muestran formato y tamaño.</p></div>
            {error ? <p data-testid="cookie-error" role="alert" className="mt-3 rounded-2xl border border-red-300/20 bg-red-300/[0.07] p-3 text-sm leading-5 text-red-100">{error}</p> : null}
            <div className="mt-4 grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => { clearCaptured(); setError(null) }} className="min-h-12 rounded-2xl border border-white/12 text-sm font-semibold">LIMPIAR</button><button type="button" onClick={() => { void submit() }} disabled={!captured || busy} data-testid="cookie-import" className="min-h-12 rounded-2xl bg-white text-sm font-semibold text-black disabled:opacity-40">{busy ? 'VALIDANDO EN EL SERVIDOR…' : 'IMPORTAR Y VALIDAR'}</button></div>
          </div>
        ) : (
          <div data-testid="cookie-success" className="mt-5 rounded-[22px] border border-emerald-300/20 bg-emerald-300/[0.06] p-4">
            <p className="text-sm font-semibold text-emerald-100">{status ? statusLabel(status) : 'RESTAURANDO SESIÓN…'}</p>
            <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-white/45">Persistencia</dt><dd>Cifrada · DO SQLite</dd></div><div><dt className="text-white/45">Sampler</dt><dd>Servidor · ~60 s</dd></div><div><dt className="text-white/45">Historia cruda</dt><dd>Rolling 24 h</dd></div><div><dt className="text-white/45">Filtrado seguro</dt><dd>{status ? `${status.expiredDropped + status.invalidDropped} descartadas` : '—'}</dd></div><div><dt className="text-white/45">Observaciones</dt><dd>{history?.points.length ?? 0}</dd></div><div><dt className="text-white/45">Tramos</dt><dd>{history?.segments.length ?? 0}</dd></div></dl>
            {status?.state === 'no_location' ? <p role="status" className="mt-4 rounded-xl border border-white/10 p-3 text-sm text-white/65">La autenticación fue aceptada. La captura queda activa desde T0 aunque Google todavía no devuelva una ubicación compartida.</p> : null}
            {error ? <p role="alert" className="mt-3 rounded-xl border border-red-300/20 p-3 text-sm text-red-100">{error}</p> : null}
            <div className="mt-4 grid gap-3 sm:grid-cols-2"><button type="button" onClick={() => { void doRefresh() }} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-white/12 text-sm font-semibold"><RefreshCw size={17} />ACTUALIZAR</button><button type="button" onClick={() => { void clearModel() }} disabled={busy} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-white/12 text-sm font-semibold"><History size={17} />BORRAR MEMORIA</button><button type="button" onClick={() => { void clearServerSession() }} data-testid="cookie-delete" className="flex min-h-12 items-center justify-center gap-2 rounded-2xl border border-white/12 text-sm font-semibold sm:col-span-2"><Trash2 size={17} />BORRAR SESIÓN</button></div>
          </div>
        )}
      </section>
    </main>
  )
}
