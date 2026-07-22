'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { NativeCreateSessionResponse, NativeSharedLocationPoint, SharingSessionState } from './contracts'
import {
  createNativeSession,
  NativeSharingApiError,
  publishNativePoint,
  revokeNativeSession,
  rotateNativeViewer,
} from './native-sharing-api'

interface NativeEmitterController {
  state: SharingSessionState
  session: NativeCreateSessionResponse | null
  lastUpdate: string | null
  remainingMs: number | null
  error: string | null
  start: (durationMs: number) => void
  stopTransmission: () => void
  revoke: () => Promise<void>
  rotateViewer: () => Promise<void>
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

export function useNativeEmitter(): NativeEmitterController {
  const [state, setState] = useState<SharingSessionState>('not-started')
  const [session, setSession] = useState<NativeCreateSessionResponse | null>(null)
  const [lastUpdate, setLastUpdate] = useState<string | null>(null)
  const [remainingMs, setRemainingMs] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const watchRef = useRef<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const generationRef = useRef(0)
  const sequenceRef = useRef(0)
  const lastSentAtRef = useRef(0)
  const stateRef = useRef<SharingSessionState>('not-started')
  const sessionRef = useRef<NativeCreateSessionResponse | null>(null)
  const controllersRef = useRef(new Set<AbortController>())
  const publishQueueRef = useRef<Promise<void>>(Promise.resolve())

  const setExactState = useCallback((next: SharingSessionState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const clearTransport = useCallback(() => {
    generationRef.current += 1
    if (watchRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) navigator.geolocation.clearWatch(watchRef.current)
    watchRef.current = null
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    for (const controller of controllersRef.current) controller.abort()
    controllersRef.current.clear()
    publishQueueRef.current = Promise.resolve()
  }, [])

  const stopTransmission = useCallback(() => {
    clearTransport()
    if (sessionRef.current && !['revoked', 'expired'].includes(stateRef.current)) setExactState('paused')
  }, [clearTransport, setExactState])

  useEffect(() => () => clearTransport(), [clearTransport])

  useEffect(() => {
    const visibility = () => {
      if (!sessionRef.current || !watchRef.current) return
      setExactState(document.visibilityState === 'visible' ? 'active' : 'paused')
    }
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [setExactState])

  const start = useCallback((durationMs: number) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setExactState('error')
      setError('Este navegador no ofrece geolocalización.')
      return
    }
    clearTransport()
    sequenceRef.current = 0
    lastSentAtRef.current = 0
    setSession(null)
    sessionRef.current = null
    setLastUpdate(null)
    setRemainingMs(null)
    setError(null)
    setExactState('requesting-permission')
    const generation = generationRef.current

    navigator.geolocation.getCurrentPosition(
      (initialPosition) => {
        if (generation !== generationRef.current) return
        void (async () => {
          const controller = new AbortController()
          controllersRef.current.add(controller)
          try {
            const created = await createNativeSession(durationMs, controller.signal)
            if (generation !== generationRef.current) return
            sessionRef.current = created
            setSession(created)
            setRemainingMs(Math.max(0, Date.parse(created.expiresAt) - Date.now()))

            const send = (position: GeolocationPosition) => {
              if (generation !== generationRef.current || !sessionRef.current) return
              const capturedMs = Number.isFinite(position.timestamp) && position.timestamp > 0 ? position.timestamp : Date.now()
              if (capturedMs - lastSentAtRef.current < 5_000) return
              lastSentAtRef.current = capturedMs
              sequenceRef.current += 1
              const point: NativeSharedLocationPoint = {
                version: 1,
                sequence: sequenceRef.current,
                lat: position.coords.latitude,
                lng: position.coords.longitude,
                accuracyM: finiteOrNull(position.coords.accuracy),
                speedMps: finiteOrNull(position.coords.speed),
                headingDeg: finiteOrNull(position.coords.heading),
                capturedAt: new Date(capturedMs).toISOString(),
              }
              publishQueueRef.current = publishQueueRef.current.then(async () => {
                if (generation !== generationRef.current || !sessionRef.current) return
                const publishController = new AbortController()
                controllersRef.current.add(publishController)
                try {
                  const accepted = await publishNativePoint(sessionRef.current.sessionId, sessionRef.current.emitterToken, point, publishController.signal)
                  if (generation !== generationRef.current) return
                  setLastUpdate(accepted.receivedAt)
                  setExactState(document.visibilityState === 'visible' ? 'active' : 'paused')
                  setError(null)
                } catch (caught) {
                  if (publishController.signal.aborted || generation !== generationRef.current) return
                  setExactState(caught instanceof NativeSharingApiError && caught.code === 'SESSION_EXPIRED' ? 'expired' : 'error')
                  setError(errorMessage(caught))
                } finally {
                  controllersRef.current.delete(publishController)
                }
              })
            }

            send(initialPosition)
            watchRef.current = navigator.geolocation.watchPosition(send, (geoError) => {
              if (generation !== generationRef.current) return
              setExactState(errorState(geoError))
              setError(geoError.code === geoError.PERMISSION_DENIED ? 'El permiso de ubicación fue denegado.' : 'El teléfono no pudo actualizar la ubicación.')
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
            if (controller.signal.aborted || generation !== generationRef.current) return
            setExactState('error')
            setError(errorMessage(caught))
          } finally {
            controllersRef.current.delete(controller)
          }
        })()
      },
      (geoError) => {
        if (generation !== generationRef.current) return
        setExactState(errorState(geoError))
        setError(geoError.code === geoError.PERMISSION_DENIED ? 'El permiso de ubicación fue denegado.' : 'No se pudo obtener una ubicación inicial.')
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    )
  }, [clearTransport, setExactState])

  const revoke = useCallback(async () => {
    const current = sessionRef.current
    if (!current) return
    clearTransport()
    try {
      await revokeNativeSession(current.sessionId, current.emitterToken)
      setExactState('revoked')
      setRemainingMs(0)
    } catch (caught) {
      setExactState('error')
      setError(errorMessage(caught))
      throw caught
    }
  }, [clearTransport, setExactState])

  const rotateViewer = useCallback(async () => {
    const current = sessionRef.current
    if (!current) return
    try {
      const rotated = await rotateNativeViewer(current.sessionId, current.emitterToken)
      const next = { ...current, viewerCapability: rotated.viewerCapability }
      sessionRef.current = next
      setSession(next)
    } catch (caught) {
      setError(errorMessage(caught))
      throw caught
    }
  }, [])

  return { state, session, lastUpdate, remainingMs, error, start, stopTransmission, revoke, rotateViewer }
}
