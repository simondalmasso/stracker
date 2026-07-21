'use client'

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  clearAuthorizedSession,
  detectCookieFormat,
  establishApplicationSession,
  getSessionStatus,
  importAuthorizedSession,
  type CookieFormat,
  type SessionState,
  type SessionStatus,
  unlockedSessionStates,
} from '@/lib/session-client'

const EMPTY_STATUS: SessionStatus = {
  state: 'UNCONFIGURED',
  map_unlocked: false,
  configured: false,
  cookie_count: 0,
  critical_present: [],
  critical_missing: [],
}

const ERROR_COPY: Record<string, { title: string; action: string }> = {
  FORMAT_NOT_RECOGNIZED: {
    title: 'Formato no reconocido',
    action: 'Usá Cookie Editor JSON, JSON envuelto, Cookie Header String o Netscape.',
  },
  COOKIES_INCOMPLETE: {
    title: 'Cookies incompletas',
    action: 'Exportá nuevamente todas las cookies de google.com.',
  },
  SESSION_EXPIRED: {
    title: 'Sesión vencida',
    action: 'Reemplazá la sesión con una exportación reciente.',
  },
  GOOGLE_NO_LOCATION: {
    title: 'Google no devuelve ubicación',
    action: 'Confirmá que la ubicación compartida esté habilitada.',
  },
  UPSTREAM_UNAVAILABLE: {
    title: 'Servicio temporalmente no disponible',
    action: 'Esperá unos minutos y reintentá.',
  },
  ACCESS_REQUIRED: {
    title: 'Acceso privado requerido',
    action: 'Ingresá mediante el acceso privado configurado para STRACKER.',
  },
}

function formatLabel(format: CookieFormat): string {
  switch (format) {
    case 'COOKIE_EDITOR_JSON':
      return 'Cookie Editor JSON'
    case 'WRAPPED_JSON':
      return 'JSON envuelto'
    case 'COOKIE_HEADER_STRING':
      return 'Cookie Header String'
    case 'NETSCAPE':
      return 'Netscape'
    default:
      return 'Sin detectar'
  }
}

function ScreenShell({ children }: { children: ReactNode }) {
  return (
    <main
      className="session-screen"
      style={{
        minHeight: '100dvh',
        width: '100%',
        overflowX: 'hidden',
        background: '#000',
        color: '#f5f5f7',
        paddingTop: 'max(20px, env(safe-area-inset-top))',
        paddingRight: 'max(18px, env(safe-area-inset-right))',
        paddingBottom: 'max(20px, env(safe-area-inset-bottom))',
        paddingLeft: 'max(18px, env(safe-area-inset-left))',
      }}
    >
      <div style={{ width: '100%', maxWidth: 440, minHeight: 'calc(100dvh - 40px)', margin: '0 auto' }}>{children}</div>
    </main>
  )
}

function PrimaryButton({
  children,
  disabled,
  onClick,
  type = 'button',
  testId,
}: {
  children: ReactNode
  disabled?: boolean
  onClick?: () => void
  type?: 'button' | 'submit'
  testId?: string
}) {
  return (
    <button
      type={type}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: '100%',
        minHeight: 52,
        borderRadius: 14,
        border: '1px solid rgba(255,255,255,.14)',
        background: disabled ? '#151515' : '#f5f5f7',
        color: disabled ? '#6e6e73' : '#050505',
        fontSize: 14,
        fontWeight: 750,
        letterSpacing: '.06em',
        textTransform: 'uppercase',
        touchAction: 'manipulation',
      }}
    >
      {children}
    </button>
  )
}

function SecondaryButton({ children, onClick, testId }: { children: ReactNode; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      style={{
        minWidth: 44,
        minHeight: 44,
        padding: '0 14px',
        borderRadius: 12,
        border: '1px solid rgba(255,255,255,.12)',
        background: 'rgba(255,255,255,.04)',
        color: '#d1d1d6',
        fontSize: 13,
        fontWeight: 650,
        touchAction: 'manipulation',
      }}
    >
      {children}
    </button>
  )
}

function Welcome({ accessReady, accessError, onImport }: { accessReady: boolean; accessError: string | null; onImport: () => void }) {
  return (
    <ScreenShell>
      <section
        data-testid="session-welcome"
        style={{ minHeight: 'calc(100dvh - 40px)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}
      >
        <div style={{ paddingTop: 'clamp(56px, 15vh, 128px)' }}>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '.22em' }}>STRACKER</div>
          <h1 style={{ marginTop: 18, maxWidth: 320, fontSize: 'clamp(31px, 10vw, 46px)', lineHeight: .98, letterSpacing: '-.055em', fontWeight: 760 }}>
            Ubicación privada en tiempo real
          </h1>
          <p style={{ marginTop: 22, maxWidth: 340, color: '#8e8e93', fontSize: 16, lineHeight: 1.45 }}>
            Para comenzar, vinculá tu sesión autorizada de Google Maps.
          </p>
          <p style={{ marginTop: 12, maxWidth: 360, color: '#636366', fontSize: 12, lineHeight: 1.45 }}>
            Google Location Sharing no ofrece una API pública compatible. STRACKER importa una sesión autorizada y la valida en el backend; no simula OAuth.
          </p>
        </div>
        <div style={{ display: 'grid', gap: 12, paddingBottom: 6 }}>
          {accessError ? (
            <div role="alert" style={{ border: '1px solid rgba(255,69,58,.28)', background: 'rgba(255,69,58,.08)', borderRadius: 14, padding: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Acceso privado no establecido</div>
              <div style={{ marginTop: 5, color: '#a1a1a6', fontSize: 13, lineHeight: 1.4 }}>{accessError}</div>
            </div>
          ) : null}
          <PrimaryButton testId="open-session-import" disabled={!accessReady} onClick={onImport}>
            Importar sesión
          </PrimaryButton>
          <div style={{ textAlign: 'center', color: '#48484a', fontSize: 11 }}>Las cookies nunca se guardan en el navegador.</div>
        </div>
      </section>
    </ScreenShell>
  )
}

interface ImportViewProps {
  raw: string
  format: CookieFormat
  busy: boolean
  result: SessionStatus | null
  error: { code: string; message: string; action: string } | null
  onRaw: (value: string) => void
  onPaste: () => void
  onSubmit: () => void
  onCancel: () => void
}

function ImportView({ raw, format, busy, result, error, onRaw, onPaste, onSubmit, onCancel }: ImportViewProps) {
  const criticalPresent = result?.critical_present ?? []
  const criticalMissing = result?.critical_missing ?? []
  return (
    <ScreenShell>
      <section data-testid="session-import" style={{ minHeight: 'calc(100dvh - 40px)', display: 'flex', flexDirection: 'column' }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 52 }}>
          <div>
            <div style={{ color: '#8e8e93', fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase' }}>Sesión autorizada</div>
            <h1 style={{ marginTop: 3, fontSize: 23, letterSpacing: '-.03em', fontWeight: 720 }}>Importar sesión</h1>
          </div>
          <SecondaryButton testId="cancel-session-import" onClick={onCancel}>Cancelar</SecondaryButton>
        </header>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 22, marginBottom: 9 }}>
          <label htmlFor="session-source" style={{ fontSize: 13, fontWeight: 650 }}>Datos de sesión</label>
          <SecondaryButton testId="paste-session" onClick={onPaste}>Pegar</SecondaryButton>
        </div>
        <textarea
          id="session-source"
          data-testid="session-textarea"
          value={raw}
          onChange={(event) => onRaw(event.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          placeholder="Pegá Cookie Editor JSON, Header String o Netscape"
          style={{
            width: '100%',
            minHeight: 'clamp(210px, 38dvh, 360px)',
            maxHeight: '48dvh',
            resize: 'vertical',
            overflowWrap: 'anywhere',
            whiteSpace: 'pre-wrap',
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,.12)',
            background: '#0b0b0c',
            color: '#f5f5f7',
            padding: 15,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 13,
            lineHeight: 1.45,
            outline: 'none',
          }}
        />

        <div style={{ marginTop: 12, display: 'grid', gap: 7, borderRadius: 14, background: '#0b0b0c', border: '1px solid rgba(255,255,255,.08)', padding: 13 }}>
          <StatusRow label="Formato detectado" value={formatLabel(format)} />
          <StatusRow label="Cookies válidas" value={result ? String(result.cookie_count) : 'Pendiente'} />
          <StatusRow label="Críticas presentes" value={result ? String(criticalPresent.length) : 'Pendiente'} />
          <StatusRow label="Críticas faltantes" value={result ? String(criticalMissing.length) : 'Pendiente'} warn={Boolean(result && criticalMissing.length)} />
          <StatusRow label="Estado de validación" value={busy ? 'Validando…' : result?.state ?? 'Pendiente'} warn={result?.state === 'EXPIRED' || result?.state === 'ERROR'} />
        </div>

        {error ? (
          <div data-testid="session-error" role="alert" style={{ marginTop: 12, borderRadius: 14, border: '1px solid rgba(255,69,58,.28)', background: 'rgba(255,69,58,.08)', padding: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 720 }}>{error.message}</div>
            <div style={{ marginTop: 5, color: '#a1a1a6', fontSize: 13, lineHeight: 1.4 }}>{error.action}</div>
          </div>
        ) : null}

        <div style={{ marginTop: 'auto', paddingTop: 18, display: 'grid', gap: 10 }}>
          <PrimaryButton testId="submit-session" disabled={!raw.trim() || !format || busy} onClick={onSubmit}>
            {busy ? 'Validando sesión…' : error ? 'Reintentar' : 'Importar y validar'}
          </PrimaryButton>
          {error ? <SecondaryButton testId="replace-session" onClick={() => onRaw('')}>Reemplazar sesión</SecondaryButton> : null}
          <p style={{ color: '#636366', fontSize: 11, lineHeight: 1.45, textAlign: 'center' }}>
            Los valores se envían una sola vez al backend, se cifran y se eliminan de este formulario al validar.
          </p>
        </div>
      </section>
    </ScreenShell>
  )
}

function StatusRow({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', minHeight: 24, alignItems: 'center', justifyContent: 'space-between', gap: 16, fontSize: 12 }}>
      <span style={{ color: '#636366' }}>{label}</span>
      <span style={{ color: warn ? '#ff9f0a' : '#d1d1d6', textAlign: 'right', overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  )
}

function ValidatingView() {
  return (
    <ScreenShell>
      <div data-testid="session-validating" style={{ minHeight: 'calc(100dvh - 40px)', display: 'grid', placeItems: 'center', textAlign: 'center' }}>
        <div>
          <div style={{ width: 12, height: 12, margin: '0 auto', borderRadius: 999, background: '#f5f5f7', animation: 'sessionPulse 1.1s ease-in-out infinite' }} />
          <h1 style={{ marginTop: 18, fontSize: 22, letterSpacing: '-.03em' }}>Validando sesión…</h1>
          <p style={{ marginTop: 9, color: '#8e8e93', fontSize: 13, lineHeight: 1.45 }}>Comprobando autenticación y contrato de ubicación.</p>
          <style>{'@keyframes sessionPulse{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}'}</style>
        </div>
      </div>
    </ScreenShell>
  )
}

function MapSessionChrome({ status, onReplace, onClear }: { status: SessionStatus; onReplace: () => void; onClear: () => void }) {
  const [open, setOpen] = useState(false)
  const warning = status.state === 'STALE'
    ? 'La última ubicación está demorada.'
    : status.state === 'NO_LOCATION'
      ? 'La sesión es válida, pero Google no devuelve ubicación activa.'
      : null
  return (
    <>
      {warning ? (
        <div
          data-testid="session-map-warning"
          style={{
            position: 'fixed',
            zIndex: 1300,
            top: 'max(62px, calc(env(safe-area-inset-top) + 54px))',
            left: 'max(12px, env(safe-area-inset-left))',
            right: 'max(12px, env(safe-area-inset-right))',
            maxWidth: 420,
            margin: '0 auto',
            padding: '9px 12px',
            borderRadius: 12,
            border: '1px solid rgba(255,159,10,.25)',
            background: 'rgba(16,16,17,.88)',
            backdropFilter: 'blur(18px)',
            color: '#ff9f0a',
            fontSize: 12,
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          {warning}
        </div>
      ) : null}
      <button
        type="button"
        data-testid="session-menu"
        aria-label="Administrar sesión"
        onClick={() => setOpen(true)}
        style={{
          position: 'fixed',
          zIndex: 1400,
          top: 'max(12px, env(safe-area-inset-top))',
          right: 'max(12px, env(safe-area-inset-right))',
          minWidth: 44,
          minHeight: 44,
          borderRadius: 14,
          border: '1px solid rgba(255,255,255,.12)',
          background: 'rgba(10,10,11,.76)',
          backdropFilter: 'blur(18px)',
          color: '#f5f5f7',
          fontSize: 12,
          fontWeight: 700,
        }}
      >
        Sesión
      </button>
      {open ? (
        <div data-testid="session-sheet" style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,.54)', display: 'flex', alignItems: 'flex-end' }} onClick={() => setOpen(false)}>
          <section
            onClick={(event) => event.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 480,
              margin: '0 auto',
              borderRadius: '22px 22px 0 0',
              border: '1px solid rgba(255,255,255,.12)',
              borderBottom: 0,
              background: '#0b0b0c',
              padding: '16px max(18px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left))',
            }}
          >
            <div style={{ width: 34, height: 4, margin: '0 auto 18px', borderRadius: 99, background: '#3a3a3c' }} />
            <h2 style={{ fontSize: 20, letterSpacing: '-.03em' }}>Sesión autorizada</h2>
            <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
              <StatusRow label="Estado" value={status.state} warn={status.state !== 'READY'} />
              <StatusRow label="Formato" value={formatLabel(status.format ?? null)} />
              <StatusRow label="Cookies válidas" value={String(status.cookie_count)} />
              <StatusRow label="Críticas faltantes" value={String(status.critical_missing.length)} warn={Boolean(status.critical_missing.length)} />
            </div>
            <div style={{ marginTop: 20, display: 'grid', gap: 10 }}>
              <PrimaryButton testId="update-session" onClick={() => { setOpen(false); onReplace() }}>Actualizar sesión</PrimaryButton>
              <SecondaryButton testId="logout-session" onClick={onClear}>Cerrar sesión</SecondaryButton>
              <SecondaryButton testId="close-session-sheet" onClick={() => setOpen(false)}>Volver al mapa</SecondaryButton>
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}

function normalizeError(error: unknown): { code: string; message: string; action: string } {
  const candidate = error as { payload?: { code?: string; message?: string; action?: string }; message?: string }
  const code = candidate.payload?.code || 'ERROR'
  const fallback = ERROR_COPY[code] || {
    title: candidate.payload?.message || candidate.message || 'No se pudo validar la sesión',
    action: candidate.payload?.action || 'Reintentá o reemplazá la sesión.',
  }
  return {
    code,
    message: candidate.payload?.message || fallback.title,
    action: candidate.payload?.action || fallback.action,
  }
}

export function SessionGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>(EMPTY_STATUS)
  const [accessReady, setAccessReady] = useState(false)
  const [accessError, setAccessError] = useState<string | null>(null)
  const [view, setView] = useState<'LOADING' | 'WELCOME' | 'IMPORT' | 'VALIDATING' | 'MAP'>('LOADING')
  const [raw, setRaw] = useState('')
  const [result, setResult] = useState<SessionStatus | null>(null)
  const [error, setError] = useState<{ code: string; message: string; action: string } | null>(null)
  const mountedRef = useRef(true)

  const applyStatus = useCallback((next: SessionStatus) => {
    if (!mountedRef.current) return
    setStatus(next)
    setResult(next)
    setView(unlockedSessionStates.has(next.state) && next.map_unlocked ? 'MAP' : 'WELCOME')
  }, [])

  const bootstrap = useCallback(async () => {
    try {
      await establishApplicationSession()
      if (!mountedRef.current) return
      setAccessReady(true)
      setAccessError(null)
      const next = await getSessionStatus()
      applyStatus(next)
    } catch (bootstrapError) {
      if (!mountedRef.current) return
      const normalized = normalizeError(bootstrapError)
      setAccessReady(false)
      setAccessError(normalized.action)
      setView('WELCOME')
    }
  }, [applyStatus])

  useEffect(() => {
    mountedRef.current = true
    void bootstrap()
    return () => {
      mountedRef.current = false
      setRaw('')
    }
  }, [bootstrap])

  useEffect(() => {
    if (view !== 'MAP') return
    const timer = window.setInterval(async () => {
      try {
        const next = await getSessionStatus()
        if (!mountedRef.current) return
        setStatus(next)
        if (!unlockedSessionStates.has(next.state) || !next.map_unlocked) {
          setView('WELCOME')
        }
      } catch {
        if (!mountedRef.current) return
        setStatus((previous) => ({ ...previous, state: 'ERROR' }))
      }
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [view])

  const detectedFormat = useMemo(() => detectCookieFormat(raw), [raw])

  const openImport = useCallback(() => {
    setRaw('')
    setResult(null)
    setError(null)
    setView('IMPORT')
  }, [])

  const paste = useCallback(async () => {
    try {
      const value = await navigator.clipboard.readText()
      setRaw(value)
      setError(null)
    } catch {
      setError({ code: 'CLIPBOARD_UNAVAILABLE', message: 'No se pudo leer el portapapeles.', action: 'Mantené presionado el campo y elegí Pegar.' })
    }
  }, [])

  const submit = useCallback(async () => {
    if (!raw.trim() || !detectedFormat) return
    setError(null)
    setView('VALIDATING')
    try {
      const next = await importAuthorizedSession(raw)
      setRaw('')
      setStatus(next)
      setResult(next)
      if (unlockedSessionStates.has(next.state) && next.map_unlocked) {
        setView('MAP')
      } else {
        setView('IMPORT')
        const code = next.validation_code || next.code || 'ERROR'
        const copy = ERROR_COPY[code] || { title: next.message || 'No se pudo validar la sesión', action: next.action || 'Reintentá o reemplazá la sesión.' }
        setError({ code, message: next.message || copy.title, action: next.action || copy.action })
      }
    } catch (submitError) {
      setView('IMPORT')
      setError(normalizeError(submitError))
    }
  }, [detectedFormat, raw])

  const clear = useCallback(async () => {
    try {
      await clearAuthorizedSession()
    } finally {
      setRaw('')
      setResult(null)
      setError(null)
      setStatus(EMPTY_STATUS)
      setView('WELCOME')
    }
  }, [])

  if (view === 'LOADING') return <ValidatingView />
  if (view === 'WELCOME') return <Welcome accessReady={accessReady} accessError={accessError} onImport={openImport} />
  if (view === 'VALIDATING') return <ValidatingView />
  if (view === 'IMPORT') {
    return (
      <ImportView
        raw={raw}
        format={detectedFormat}
        busy={false}
        result={result}
        error={error}
        onRaw={(value) => { setRaw(value); setError(null); setResult(null) }}
        onPaste={() => void paste()}
        onSubmit={() => void submit()}
        onCancel={() => setView(unlockedSessionStates.has(status.state) ? 'MAP' : 'WELCOME')}
      />
    )
  }
  return (
    <div data-testid="session-map" style={{ width: '100%', height: '100dvh', overflow: 'hidden', background: '#000' }}>
      {children}
      <MapSessionChrome status={status} onReplace={openImport} onClear={() => void clear()} />
    </div>
  )
}
