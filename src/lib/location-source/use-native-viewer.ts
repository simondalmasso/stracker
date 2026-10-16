'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FreshnessState,
  GhostRailSegment,
  LocationSample,
  LocationSnapshot,
  MotionState,
  NativeViewerExchangeResponse,
  PilotNetworkState,
  PilotRuntimeIdentity,
  SourceHealth,
  ViewerSessionState,
} from './contracts'
import {
  initialLocationPipelineState,
  processLocationSample,
  recordPipelineError,
  refreshPipelineTime,
  type LocationPipelineState,
} from './location-pipeline'
import {
  exchangeNativeViewerCapability,
  fetchNativeViewerPoints,
  fetchNativeViewerStatus,
  logoutNativeViewer,
  NativeSharingApiError,
  readViewerCapabilityFromFragment,
  removeViewerCapabilityFragment,
} from './native-sharing-api'
import {
  clearPersistedViewerSession,
  persistViewerSession,
  readPersistedViewerSession,
} from './viewer-session-recovery'
import {
  buildPilotDiagnostic,
  fetchPilotRuntimeIdentity,
  pilotHttpStatusCategory,
  serializePilotDiagnostic,
} from './pilot-runtime'

interface NativeViewerController {
  state: ViewerSessionState
  snapshot: LocationSnapshot | null
  ghostrail: GhostRailSegment[]
  motionState: MotionState
  freshnessState: FreshnessState
  sourceHealth: SourceHealth
  networkState: PilotNetworkState
  loading: boolean
  error: string | null
  lastHttpStatusCategory: string
  pollAttemptCount: number
  pollSuccessCount: number
  start: () => Promise<void>
  stop: () => void
  getDiagnostic: () => Promise<string>
}

function message(error: unknown): string {
  if (error instanceof NativeSharingApiError) return error.message
  if (error instanceof Error) return error.message
  return 'No se pudo abrir la ubicación compartida.'
}

export function useNativeViewer(): NativeViewerController {
  const [state, setState] = useState<ViewerSessionState>('unconfirmed')
  const [snapshot, setSnapshot] = useState<LocationSnapshot | null>(null)
  const [ghostrail, setGhostrail] = useState<GhostRailSegment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [networkState, setNetworkState] = useState<PilotNetworkState>('online')
  const [lastHttpStatusCategory, setLastHttpStatusCategory] = useState('NONE')
  const [pollAttemptCount, setPollAttemptCount] = useState(0)
  const [pollSuccessCount, setPollSuccessCount] = useState(0)
  const [runtimeIdentity, setRuntimeIdentity] = useState<PilotRuntimeIdentity>({ buildSha: 'UNKNOWN', versionId: 'UNKNOWN' })
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const freshnessRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const resumeRef = useRef<(() => void) | null>(null)
  const autoRecoveryStartedRef = useRef(false)
  const generationRef = useRef(0)
  const lastSequenceRef = useRef(0)
  const stateRef = useRef<ViewerSessionState>('unconfirmed')
  const viewerSessionRef = useRef<NativeViewerExchangeResponse | null>(null)
  const pipelineRef = useRef<LocationPipelineState>(initialLocationPipelineState('shared-location'))
  const onlineRef = useRef(true)

  const setExactState = useCallback((next: ViewerSessionState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const abortTransport = useCallback(() => {
    generationRef.current += 1
    if (pollRef.current) clearInterval(pollRef.current)
    if (freshnessRef.current) clearInterval(freshnessRef.current)
    pollRef.current = null
    freshnessRef.current = null
    resumeRef.current = null
    requestRef.current?.abort()
    requestRef.current = null
  }, [])

  const clearLocalState = useCallback(() => {
    pipelineRef.current = initialLocationPipelineState('shared-location', pipelineRef.current.sessionEpoch + 1)
    viewerSessionRef.current = null
    lastSequenceRef.current = 0
    setSnapshot(null)
    setGhostrail([])
    setError(null)
    setLoading(false)
  }, [])

  const stop = useCallback(() => {
    const viewerSession = viewerSessionRef.current
    abortTransport()
    clearPersistedViewerSession()
    clearLocalState()
    setExactState('unconfirmed')
    setNetworkState(onlineRef.current ? 'online' : 'offline')
    if (viewerSession) void logoutNativeViewer(viewerSession.sessionId, viewerSession.viewerSessionToken).catch(() => undefined)
  }, [abortTransport, clearLocalState, setExactState])

  useEffect(() => {
    onlineRef.current = navigator.onLine
    const identityController = new AbortController()
    queueMicrotask(() => setNetworkState(navigator.onLine ? 'online' : 'offline'))
    void fetchPilotRuntimeIdentity(identityController.signal).then(setRuntimeIdentity)
    const online = () => {
      onlineRef.current = true
      setNetworkState(viewerSessionRef.current ? 'recovering' : 'online')
      resumeRef.current?.()
    }
    const offline = () => {
      onlineRef.current = false
      setNetworkState('offline')
    }
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    return () => {
      identityController.abort()
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
    }
  }, [])

  useEffect(() => {
    const resume = () => {
      if (document.visibilityState !== 'visible' || !viewerSessionRef.current) return
      setNetworkState(onlineRef.current ? 'recovering' : 'offline')
      resumeRef.current?.()
    }
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('pageshow', resume)
    return () => {
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('pageshow', resume)
    }
  }, [])

  useEffect(() => () => {
    abortTransport()
  }, [abortTransport])

  const start = useCallback(async () => {
    const viewerCapability = readViewerCapabilityFromFragment()
    const recoveredSession = viewerCapability ? null : readPersistedViewerSession()
    const priorViewerSession = viewerSessionRef.current
    abortTransport()
    clearLocalState()
    if (priorViewerSession && viewerCapability) {
      clearPersistedViewerSession()
      void logoutNativeViewer(priorViewerSession.sessionId, priorViewerSession.viewerSessionToken).catch(() => undefined)
    }
    setLoading(true)
    setExactState('validating')
    setPollAttemptCount(0)
    setPollSuccessCount(0)

    const generation = generationRef.current
    if (recoveredSession) {
      viewerSessionRef.current = recoveredSession
      setNetworkState(onlineRef.current ? 'recovering' : 'offline')
    } else {
      if (!viewerCapability) {
        setLoading(false)
        setExactState('invalid')
        setError('El enlace privado no es válido o la recuperación segura de esta pestaña venció.')
        return
      }

      const exchangeController = new AbortController()
      requestRef.current = exchangeController
      try {
        setNetworkState(onlineRef.current ? 'sending' : 'offline')
        const exchanged = await exchangeNativeViewerCapability(viewerCapability, exchangeController.signal)
        if (generation !== generationRef.current || exchangeController.signal.aborted) return
        setLastHttpStatusCategory('HTTP_2XX')
        viewerSessionRef.current = exchanged
        persistViewerSession(exchanged)
        removeViewerCapabilityFragment()
      } catch (caught) {
        if (generation !== generationRef.current || exchangeController.signal.aborted) return
        clearPersistedViewerSession()
        setLastHttpStatusCategory(caught instanceof NativeSharingApiError ? pilotHttpStatusCategory(caught.status) : pilotHttpStatusCategory(caught))
        setNetworkState(onlineRef.current ? 'error' : 'offline')
        setLoading(false)
        setExactState(caught instanceof NativeSharingApiError && caught.code === 'SESSION_EXPIRED' ? 'expired' : caught instanceof NativeSharingApiError && caught.code === 'SESSION_REVOKED' ? 'revoked' : 'invalid')
        setError(message(caught))
        return
      }
    }

    const load = async () => {
      const viewerSession = viewerSessionRef.current
      if (!viewerSession || generation !== generationRef.current) return
      if (Date.now() > Date.parse(viewerSession.expiresAt)) {
        abortTransport()
        clearPersistedViewerSession()
        clearLocalState()
        setExactState('expired')
        setError('La sesión de visualización venció.')
        return
      }
      if (!onlineRef.current) {
        pipelineRef.current = recordPipelineError(pipelineRef.current)
        setSnapshot(pipelineRef.current.latest)
        setGhostrail(pipelineRef.current.rail.segments)
        setExactState('stale')
        setNetworkState('offline')
        setError('Sin conexión. Se conserva únicamente el último punto recibido, marcado con su antigüedad.')
        setLoading(false)
        return
      }

      const controller = new AbortController()
      requestRef.current?.abort()
      requestRef.current = controller
      setPollAttemptCount((value) => value + 1)
      setNetworkState('sending')
      try {
        const status = await fetchNativeViewerStatus(viewerSession.sessionId, viewerSession.viewerSessionToken, controller.signal)
        if (generation !== generationRef.current || controller.signal.aborted || viewerSession !== viewerSessionRef.current) return
        setExactState(status.state)
        const payload = await fetchNativeViewerPoints(viewerSession.sessionId, viewerSession.viewerSessionToken, controller.signal)
        if (generation !== generationRef.current || controller.signal.aborted || viewerSession !== viewerSessionRef.current) return
        setExactState(payload.state)
        const freshPoints = payload.points.filter((point) => point.sequence > lastSequenceRef.current).sort((a, b) => a.sequence - b.sequence)
        for (const point of freshPoints) {
          const sample: LocationSample = {
            source: 'shared-location',
            lat: point.lat,
            lng: point.lng,
            accuracyM: point.accuracyM,
            capturedAt: point.capturedAt,
            receivedAt: point.receivedAt,
            speedMps: point.speedMps,
            headingDeg: point.headingDeg,
          }
          const result = processLocationSample(pipelineRef.current, sample, payload.state)
          pipelineRef.current = result.state
          lastSequenceRef.current = point.sequence
        }
        setSnapshot(pipelineRef.current.latest)
        setGhostrail(pipelineRef.current.rail.segments)
        setLastHttpStatusCategory('HTTP_2XX')
        setPollSuccessCount((value) => value + 1)
        setNetworkState('online')
        setError(null)
        setLoading(false)
      } catch (caught) {
        if (generation !== generationRef.current || controller.signal.aborted || viewerSession !== viewerSessionRef.current) return
        setLastHttpStatusCategory(caught instanceof NativeSharingApiError ? pilotHttpStatusCategory(caught.status) : pilotHttpStatusCategory(caught))
        pipelineRef.current = recordPipelineError(pipelineRef.current)
        setSnapshot(pipelineRef.current.latest)
        setGhostrail(pipelineRef.current.rail.segments)
        if (caught instanceof NativeSharingApiError && (caught.code === 'SESSION_REVOKED' || caught.code === 'VIEWER_SESSION_INVALID')) {
          abortTransport()
          clearPersistedViewerSession()
          clearLocalState()
          setExactState('revoked')
        } else if (caught instanceof NativeSharingApiError && (caught.code === 'SESSION_EXPIRED' || caught.code === 'VIEWER_SESSION_EXPIRED')) {
          abortTransport()
          clearPersistedViewerSession()
          clearLocalState()
          setExactState('expired')
        } else if (caught instanceof NativeSharingApiError && caught.status === 404) {
          abortTransport()
          clearPersistedViewerSession()
          clearLocalState()
          setExactState('invalid')
        } else {
          setExactState('stale')
          setNetworkState(onlineRef.current ? 'recovering' : 'offline')
        }
        setError(message(caught))
        setLoading(false)
      }
    }

    resumeRef.current = () => { void load() }
    await load()
    if (generation !== generationRef.current || !viewerSessionRef.current || ['expired', 'revoked', 'invalid'].includes(stateRef.current)) return
    pollRef.current = setInterval(() => void load(), 10_000)
    freshnessRef.current = setInterval(() => {
      if (generation !== generationRef.current || !viewerSessionRef.current) return
      pipelineRef.current = refreshPipelineTime(pipelineRef.current, stateRef.current)
      setSnapshot(pipelineRef.current.latest)
      setGhostrail(pipelineRef.current.rail.segments)
    }, 1_000)
  }, [abortTransport, clearLocalState, setExactState])

  useEffect(() => {
    if (autoRecoveryStartedRef.current) return
    if (readViewerCapabilityFromFragment() || !readPersistedViewerSession()) return
    autoRecoveryStartedRef.current = true
    const timer = window.setTimeout(() => { void start() }, 0)
    return () => window.clearTimeout(timer)
  }, [start])

  const getDiagnostic = useCallback(async () => serializePilotDiagnostic(await buildPilotDiagnostic({
    identity: runtimeIdentity,
    wakeLockSupported: false,
    wakeLockHeld: false,
    lastHttpStatusCategory,
    pointAttemptCount: pollAttemptCount,
    pointSuccessCount: pollSuccessCount,
    lastSuccessAt: snapshot?.receivedAt ?? null,
  })), [lastHttpStatusCategory, pollAttemptCount, pollSuccessCount, runtimeIdentity, snapshot?.receivedAt])

  return {
    state,
    snapshot,
    ghostrail,
    motionState: snapshot?.motion ?? 'unknown',
    freshnessState: snapshot?.freshness ?? 'unknown',
    sourceHealth: snapshot?.health ?? 'unknown',
    networkState,
    loading,
    error,
    lastHttpStatusCategory,
    pollAttemptCount,
    pollSuccessCount,
    start,
    stop,
    getDiagnostic,
  }
}
