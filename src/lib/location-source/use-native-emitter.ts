'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  NativeCreateSessionResponse,
  NativeSharedLocationPoint,
  PilotAccuracyState,
  PilotNetworkState,
  PilotRuntimeIdentity,
  SharingSessionState,
} from './contracts'
import {
  createNativeSession,
  NativeSharingApiError,
  publishNativePoint,
  revokeNativeSession,
  rotateNativeViewer,
} from './native-sharing-api'
import {
  buildPilotDiagnostic,
  fetchPilotRuntimeIdentity,
  PILOT_REQUEST_TIMEOUT_MS,
  PILOT_RETRY_DELAYS_MS,
  pilotAccuracyState,
  pilotHttpStatusCategory,
  serializePilotDiagnostic,
} from './pilot-runtime'

interface PilotWakeLockSentinel {
  released: boolean
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
}

interface NavigatorWithWakeLock {
  wakeLock?: {
    request(type: 'screen'): Promise<PilotWakeLockSentinel>
  }
}

interface NativeEmitterController {
  state: SharingSessionState
  session: NativeCreateSessionResponse | null
  lastUpdate: string | null
  remainingMs: number | null
  error: string | null
  networkState: PilotNetworkState
  accuracyState: PilotAccuracyState
  wakeLockSupported: boolean
  wakeLockHeld: boolean
  visibilityState: string
  pointAttemptCount: number
  pointSuccessCount: number
  lastHttpStatusCategory: string
  start: (durationMs: number) => void
  stopTransmission: () => Promise<void>
  revoke: () => Promise<void>
  rotateViewer: () => Promise<void>
  getDiagnostic: () => Promise<string>
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null
}

function errorState(error: GeolocationPositionError): SharingSessionState {
  return error.code === error.PERMISSION_DENIED ? 'permission-denied' : 'error'
}

function errorMessage(error: unknown): string {
  if (error instanceof NativeSharingApiError) return error.message
  if (error instanceof Error) return error.message
  return 'No se pudo compartir la ubicación.'
}

function geolocationMessage(error: GeolocationPositionError, initial: boolean): string {
  if (error.code === error.PERMISSION_DENIED) {
    return 'Permiso denegado. Abrí la configuración del sitio en Chrome, habilitá Ubicación y volvé a tocar INICIAR TRANSMISIÓN.'
  }
  if (error.code === error.TIMEOUT) {
    return 'La ubicación tardó demasiado. Mantené Chrome visible, activá Ubicación y reintentá.'
  }
  return initial
    ? 'No se obtuvo una ubicación inicial. Revisá GPS, señal y permiso; después reintentá.'
    : 'La ubicación dejó de actualizarse. Mantené la página visible y revisá GPS y señal.'
}

export function useNativeEmitter(): NativeEmitterController {
  const [state, setState] = useState<SharingSessionState>('not-started')
  const [session, setSession] = useState<NativeCreateSessionResponse | null>(null)
  const [lastUpdate, setLastUpdate] = useState<string | null>(null)
  const [remainingMs, setRemainingMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [networkState, setNetworkState] = useState<PilotNetworkState>('online')
  const [accuracyState, setAccuracyState] = useState<PilotAccuracyState>('unknown')
  const [wakeLockHeld, setWakeLockHeld] = useState(false)
  const [visibilityState, setVisibilityState] = useState('visible')
  const [pointAttemptCount, setPointAttemptCount] = useState(0)
  const [pointSuccessCount, setPointSuccessCount] = useState(0)
  const [lastHttpStatusCategory, setLastHttpStatusCategory] = useState('NONE')
  const [runtimeIdentity, setRuntimeIdentity] = useState<PilotRuntimeIdentity>({ buildSha: 'UNKNOWN', versionId: 'UNKNOWN' })

  const watchRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const retryTimerRef = useRef<number | null>(null)
  const generationRef = useRef(0)
  const sequenceRef = useRef(0)
  const lastCapturedAtRef = useRef(0)
  const stateRef = useRef<SharingSessionState>('not-started')
  const sessionRef = useRef<NativeCreateSessionResponse | null>(null)
  const controllersRef = useRef(new Set<AbortController>())
  const pendingPointRef = useRef<NativeSharedLocationPoint | null>(null)
  const publishInFlightRef = useRef(false)
  const retryIndexRef = useRef(0)
  const retryBlockedRef = useRef(false)
  const onlineRef = useRef(true)
  const visibleRef = useRef(true)
  const wakeLockRef = useRef<PilotWakeLockSentinel | null>(null)
  const flushPendingRef = useRef<() => void>(() => undefined)

  const wakeLockSupported = typeof navigator !== 'undefined' && Boolean((navigator as unknown as NavigatorWithWakeLock).wakeLock?.request)

  const setExactState = useCallback((next: SharingSessionState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const releaseWakeLock = useCallback(async () => {
    const sentinel = wakeLockRef.current
    wakeLockRef.current = null
    setWakeLockHeld(false)
    if (sentinel && !sentinel.released) await sentinel.release().catch(() => undefined)
  }, [])

  const requestWakeLock = useCallback(async () => {
    if (!sessionRef.current || !visibleRef.current || wakeLockRef.current) return
    const wakeLock = (navigator as unknown as NavigatorWithWakeLock).wakeLock
    if (!wakeLock?.request) return
    try {
      const sentinel = await wakeLock.request('screen')
      wakeLockRef.current = sentinel
      setWakeLockHeld(true)
      sentinel.addEventListener('release', () => {
        if (wakeLockRef.current === sentinel) wakeLockRef.current = null
        setWakeLockHeld(false)
      })
    } catch {
      setWakeLockHeld(false)
    }
  }, [])

  const clearTransport = useCallback(() => {
    generationRef.current += 1
    if (watchRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) navigator.geolocation.clearWatch(watchRef.current)
    watchRef.current = null
    if (timerRef.current) clearInterval(timerRef.current)
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
    timerRef.current = null
    retryTimerRef.current = null
    for (const controller of controllersRef.current) controller.abort()
    controllersRef.current.clear()
    pendingPointRef.current = null
    publishInFlightRef.current = false
    retryIndexRef.current = 0
    retryBlockedRef.current = false
    void releaseWakeLock()
  }, [releaseWakeLock])

  const flushPending = useCallback(() => {
    const currentSession = sessionRef.current
    const point = pendingPointRef.current
    if (!currentSession || !point || publishInFlightRef.current || retryBlockedRef.current) return
    if (!onlineRef.current) {
      setNetworkState('offline')
      return
    }
    if (!visibleRef.current) {
      setExactState('paused')
      return
    }

    const generation = generationRef.current
    pendingPointRef.current = null
    publishInFlightRef.current = true
    setPointAttemptCount((value) => value + 1)
    setNetworkState(retryIndexRef.current > 0 ? 'recovering' : 'sending')
    const controller = new AbortController()
    controllersRef.current.add(controller)
    const timeout = window.setTimeout(() => controller.abort(), PILOT_REQUEST_TIMEOUT_MS)

    void publishNativePoint(currentSession.sessionId, currentSession.emitterToken, point, controller.signal)
      .then((accepted) => {
        if (generation !== generationRef.current || controller.signal.aborted) return
        retryIndexRef.current = 0
        retryBlockedRef.current = false
        setPointSuccessCount((value) => value + 1)
        setLastUpdate(accepted.receivedAt)
        setLastHttpStatusCategory('HTTP_2XX')
        setNetworkState('online')
        setExactState('active')
        setError(null)
      })
      .catch((caught: unknown) => {
        if (generation !== generationRef.current) return
        const category = caught instanceof NativeSharingApiError
          ? pilotHttpStatusCategory(caught.status)
          : pilotHttpStatusCategory(caught)
        setLastHttpStatusCategory(category)

        if (caught instanceof NativeSharingApiError && caught.code === 'SESSION_EXPIRED') {
          clearTransport()
          setExactState('expired')
          setError('La sesión venció. Iniciá una transmisión nueva.')
          return
        }
        if (caught instanceof NativeSharingApiError && (caught.code === 'SESSION_REVOKED' || caught.code === 'SESSION_INACTIVE')) {
          clearTransport()
          setExactState('revoked')
          setError('La sesión ya fue revocada.')
          return
        }

        const recoverable = !(caught instanceof NativeSharingApiError)
          || caught.status === 408
          || caught.status === 429
          || caught.status >= 500
        if (!recoverable) {
          setNetworkState('error')
          setExactState('error')
          setError(errorMessage(caught))
          return
        }

        if (!pendingPointRef.current || point.sequence > pendingPointRef.current.sequence) pendingPointRef.current = point
        setNetworkState(onlineRef.current ? 'recovering' : 'offline')
        setError(onlineRef.current
          ? 'No se pudo enviar el último punto. STRACKER conserva sólo el más reciente e intenta una recuperación acotada.'
          : 'Sin conexión. STRACKER conserva sólo el último punto en memoria y lo intentará al volver la red.')
        const delay = PILOT_RETRY_DELAYS_MS[retryIndexRef.current]
        if (delay === undefined) {
          retryBlockedRef.current = true
          setNetworkState(onlineRef.current ? 'error' : 'offline')
          return
        }
        retryIndexRef.current += 1
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null
          flushPendingRef.current()
        }, delay)
      })
      .finally(() => {
        window.clearTimeout(timeout)
        controllersRef.current.delete(controller)
        publishInFlightRef.current = false
        if (pendingPointRef.current && retryTimerRef.current === null && !retryBlockedRef.current) queueMicrotask(() => flushPendingRef.current())
      })
  }, [clearTransport, setExactState])

  useEffect(() => {
    flushPendingRef.current = flushPending
  }, [flushPending])

  useEffect(() => {
    onlineRef.current = navigator.onLine
    visibleRef.current = document.visibilityState === 'visible'
    const controller = new AbortController()
    queueMicrotask(() => {
      setNetworkState(navigator.onLine ? 'online' : 'offline')
      setVisibilityState(document.visibilityState)
    })
    void fetchPilotRuntimeIdentity(controller.signal).then(setRuntimeIdentity)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const online = () => {
      onlineRef.current = true
      retryIndexRef.current = 0
      retryBlockedRef.current = false
      setNetworkState(sessionRef.current ? 'recovering' : 'online')
      flushPendingRef.current()
    }
    const offline = () => {
      onlineRef.current = false
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
      setNetworkState('offline')
    }
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
    }
  }, [])

  useEffect(() => {
    const visibility = () => {
      const visible = document.visibilityState === 'visible'
      visibleRef.current = visible
      setVisibilityState(document.visibilityState)
      if (!sessionRef.current || watchRef.current === null) return
      if (!visible) {
        setExactState('paused')
        void releaseWakeLock()
        return
      }
      retryIndexRef.current = 0
      retryBlockedRef.current = false
      setExactState('active')
      setNetworkState(onlineRef.current ? 'recovering' : 'offline')
      void requestWakeLock()
      flushPendingRef.current()
    }
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [releaseWakeLock, requestWakeLock, setExactState])

  useEffect(() => () => clearTransport(), [clearTransport])

  const start = useCallback((durationMs: number) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setExactState('error')
      setError('Este navegador no ofrece geolocalización. Usá Chrome con Ubicación habilitada.')
      return
    }
    clearTransport()
    sequenceRef.current = 0
    lastCapturedAtRef.current = 0
    setSession(null)
    sessionRef.current = null
    setLastUpdate(null)
    setRemainingMs(null)
    setAccuracyState('unknown')
    setPointAttemptCount(0)
    setPointSuccessCount(0)
    setLastHttpStatusCategory('NONE')
    setError(null)
    setExactState('requesting-permission')
    const generation = generationRef.current

    navigator.geolocation.getCurrentPosition(
      (initialPosition) => {
        if (generation !== generationRef.current) return
        void (async () => {
          const controller = new AbortController()
          controllersRef.current.add(controller)
          const timeout = window.setTimeout(() => controller.abort(), PILOT_REQUEST_TIMEOUT_MS)
          try {
            setNetworkState(onlineRef.current ? 'sending' : 'offline')
            const created = await createNativeSession(durationMs, controller.signal)
            if (generation !== generationRef.current) return
            setLastHttpStatusCategory('HTTP_2XX')
            sessionRef.current = created
            setSession(created)
            setRemainingMs(Math.max(0, Date.parse(created.expiresAt) - Date.now()))
            setExactState('active')
            setNetworkState(onlineRef.current ? 'online' : 'offline')
            void requestWakeLock()

            const queuePosition = (position: GeolocationPosition) => {
              if (generation !== generationRef.current || !sessionRef.current || !visibleRef.current) return
              const capturedMs = Number.isFinite(position.timestamp) && position.timestamp > 0 ? position.timestamp : Date.now()
              setAccuracyState(pilotAccuracyState(finiteOrNull(position.coords.accuracy)))
              if (capturedMs - lastCapturedAtRef.current < 5_000) return
              lastCapturedAtRef.current = capturedMs
              sequenceRef.current += 1
              pendingPointRef.current = {
                version: 1,
                sequence: sequenceRef.current,
                lat: position.coords.latitude,
                lng: position.coords.longitude,
                accuracyM: finiteOrNull(position.coords.accuracy),
                speedMps: finiteOrNull(position.coords.speed),
                headingDeg: finiteOrNull(position.coords.heading),
                capturedAt: new Date(capturedMs).toISOString(),
              }
              flushPendingRef.current()
            }

            queuePosition(initialPosition)
            watchRef.current = navigator.geolocation.watchPosition(queuePosition, (geoError) => {
              if (generation !== generationRef.current) return
              setExactState(errorState(geoError))
              setError(geolocationMessage(geoError, false))
            }, { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 })

            timerRef.current = setInterval(() => {
              if (generation !== generationRef.current || !sessionRef.current) return
              const remaining = Math.max(0, Date.parse(sessionRef.current.expiresAt) - Date.now())
              setRemainingMs(remaining)
              if (remaining === 0) {
                clearTransport()
                setExactState('expired')
              }
            }, 1_000)
          } catch (caught) {
            if (generation !== generationRef.current) return
            setLastHttpStatusCategory(caught instanceof NativeSharingApiError ? pilotHttpStatusCategory(caught.status) : pilotHttpStatusCategory(caught))
            setNetworkState(onlineRef.current ? 'error' : 'offline')
            setExactState('error')
            setError(errorMessage(caught))
          } finally {
            window.clearTimeout(timeout)
            controllersRef.current.delete(controller)
          }
        })()
      },
      (geoError) => {
        if (generation !== generationRef.current) return
        setExactState(errorState(geoError))
        setError(geolocationMessage(geoError, true))
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    )
  }, [clearTransport, requestWakeLock, setExactState])

  const revoke = useCallback(async () => {
    const current = sessionRef.current
    if (!current) return
    clearTransport()
    setNetworkState(onlineRef.current ? 'sending' : 'offline')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), PILOT_REQUEST_TIMEOUT_MS)
    try {
      await revokeNativeSession(current.sessionId, current.emitterToken, controller.signal)
      setLastHttpStatusCategory('HTTP_2XX')
      setNetworkState(onlineRef.current ? 'online' : 'offline')
      setExactState('revoked')
      setRemainingMs(0)
      setError(null)
    } catch (caught) {
      setLastHttpStatusCategory(caught instanceof NativeSharingApiError ? pilotHttpStatusCategory(caught.status) : pilotHttpStatusCategory(caught))
      setNetworkState(onlineRef.current ? 'error' : 'offline')
      setExactState('error')
      setError('No se confirmó la revocación. Recuperá la conexión y volvé a tocar DETENER Y REVOCAR.')
      throw caught
    } finally {
      window.clearTimeout(timeout)
    }
  }, [clearTransport, setExactState])

  const stopTransmission = useCallback(() => revoke(), [revoke])

  const rotateViewer = useCallback(async () => {
    const current = sessionRef.current
    if (!current) return
    try {
      const rotated = await rotateNativeViewer(current.sessionId, current.emitterToken)
      const next = { ...current, viewerCapability: rotated.viewerCapability }
      sessionRef.current = next
      setSession(next)
      setLastHttpStatusCategory('HTTP_2XX')
    } catch (caught) {
      setLastHttpStatusCategory(caught instanceof NativeSharingApiError ? pilotHttpStatusCategory(caught.status) : pilotHttpStatusCategory(caught))
      setError(errorMessage(caught))
      throw caught
    }
  }, [])

  const getDiagnostic = useCallback(async () => serializePilotDiagnostic(await buildPilotDiagnostic({
    identity: runtimeIdentity,
    wakeLockSupported,
    wakeLockHeld,
    lastHttpStatusCategory,
    pointAttemptCount,
    pointSuccessCount,
    lastSuccessAt: lastUpdate,
  })), [lastHttpStatusCategory, lastUpdate, pointAttemptCount, pointSuccessCount, runtimeIdentity, wakeLockHeld, wakeLockSupported])

  return {
    state,
    session,
    lastUpdate,
    remainingMs,
    error,
    networkState,
    accuracyState,
    wakeLockSupported,
    wakeLockHeld,
    visibilityState,
    pointAttemptCount,
    pointSuccessCount,
    lastHttpStatusCategory,
    start,
    stopTransmission,
    revoke,
    rotateViewer,
    getDiagnostic,
  }
}
