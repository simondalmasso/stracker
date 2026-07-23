'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FreshnessState,
  GhostRailSegment,
  LocationSample,
  LocationSnapshot,
  MotionState,
  NativeViewerExchangeResponse,
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

interface NativeViewerController {
  state: ViewerSessionState
  snapshot: LocationSnapshot | null
  ghostrail: GhostRailSegment[]
  motionState: MotionState
  freshnessState: FreshnessState
  sourceHealth: SourceHealth
  loading: boolean
  error: string | null
  start: () => Promise<void>
  stop: () => void
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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const freshnessRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)
  const lastSequenceRef = useRef(0)
  const stateRef = useRef<ViewerSessionState>('unconfirmed')
  const viewerSessionRef = useRef<NativeViewerExchangeResponse | null>(null)
  const pipelineRef = useRef<LocationPipelineState>(initialLocationPipelineState('shared-location'))

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
    clearLocalState()
    setExactState('unconfirmed')
    if (viewerSession) {
      void logoutNativeViewer(viewerSession.sessionId, viewerSession.viewerSessionToken).catch(() => undefined)
    }
  }, [abortTransport, clearLocalState, setExactState])

  useEffect(() => () => {
    const viewerSession = viewerSessionRef.current
    abortTransport()
    viewerSessionRef.current = null
    if (viewerSession) void logoutNativeViewer(viewerSession.sessionId, viewerSession.viewerSessionToken).catch(() => undefined)
  }, [abortTransport])

  const start = useCallback(async () => {
    const priorViewerSession = viewerSessionRef.current
    abortTransport()
    clearLocalState()
    if (priorViewerSession) {
      void logoutNativeViewer(priorViewerSession.sessionId, priorViewerSession.viewerSessionToken).catch(() => undefined)
    }
    setLoading(true)
    setExactState('validating')

    let viewerCapability = readViewerCapabilityFromFragment()
    if (!viewerCapability) {
      setLoading(false)
      setExactState('invalid')
      setError('El enlace privado no es válido.')
      return
    }

    const generation = generationRef.current
    const exchangeController = new AbortController()
    requestRef.current = exchangeController
    try {
      const exchanged = await exchangeNativeViewerCapability(viewerCapability, exchangeController.signal)
      if (generation !== generationRef.current || exchangeController.signal.aborted) return
      viewerSessionRef.current = exchanged
      removeViewerCapabilityFragment()
      viewerCapability = ''
    } catch (caught) {
      viewerCapability = ''
      if (generation !== generationRef.current || exchangeController.signal.aborted) return
      setLoading(false)
      setExactState(caught instanceof NativeSharingApiError && caught.code === 'SESSION_EXPIRED' ? 'expired' : caught instanceof NativeSharingApiError && caught.code === 'SESSION_REVOKED' ? 'revoked' : 'invalid')
      setError(message(caught))
      return
    }

    const load = async () => {
      const viewerSession = viewerSessionRef.current
      if (!viewerSession || generation !== generationRef.current) return
      if (Date.now() > Date.parse(viewerSession.expiresAt)) {
        abortTransport()
        clearLocalState()
        setExactState('expired')
        setError('La sesión de visualización venció.')
        return
      }

      const controller = new AbortController()
      requestRef.current?.abort()
      requestRef.current = controller
      try {
        const status = await fetchNativeViewerStatus(viewerSession.sessionId, viewerSession.viewerSessionToken, controller.signal)
        if (generation !== generationRef.current || controller.signal.aborted || viewerSession !== viewerSessionRef.current) return
        setExactState(status.state)
        const payload = await fetchNativeViewerPoints(viewerSession.sessionId, viewerSession.viewerSessionToken, controller.signal)
        if (generation !== generationRef.current || controller.signal.aborted || viewerSession !== viewerSessionRef.current) return
        setExactState(payload.state)
        const freshPoints = payload.points
          .filter((point) => point.sequence > lastSequenceRef.current)
          .sort((a, b) => a.sequence - b.sequence)
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
        setError(null)
        setLoading(false)
      } catch (caught) {
        if (generation !== generationRef.current || controller.signal.aborted || viewerSession !== viewerSessionRef.current) return
        pipelineRef.current = recordPipelineError(pipelineRef.current)
        setSnapshot(pipelineRef.current.latest)
        setGhostrail(pipelineRef.current.rail.segments)
        if (caught instanceof NativeSharingApiError && (caught.code === 'SESSION_REVOKED' || caught.code === 'VIEWER_SESSION_INVALID')) {
          abortTransport()
          clearLocalState()
          setExactState('revoked')
        } else if (caught instanceof NativeSharingApiError && (caught.code === 'SESSION_EXPIRED' || caught.code === 'VIEWER_SESSION_EXPIRED')) {
          abortTransport()
          clearLocalState()
          setExactState('expired')
        } else if (caught instanceof NativeSharingApiError && caught.status === 404) {
          abortTransport()
          clearLocalState()
          setExactState('invalid')
        } else {
          setExactState('stale')
        }
        setError(message(caught))
        setLoading(false)
      }
    }

    await load()
    if (generation !== generationRef.current || !viewerSessionRef.current || ['expired', 'revoked', 'invalid'].includes(stateRef.current)) return
    pollRef.current = setInterval(() => void load(), 10_000)
    freshnessRef.current = setInterval(() => {
      if (generation !== generationRef.current || !viewerSessionRef.current) return
      pipelineRef.current = refreshPipelineTime(pipelineRef.current, stateRef.current)
      setSnapshot(pipelineRef.current.latest)
      setGhostrail(pipelineRef.current.rail.segments)
    }, 5_000)
  }, [abortTransport, clearLocalState, setExactState])

  return {
    state,
    snapshot,
    ghostrail,
    motionState: snapshot?.motion ?? 'unknown',
    freshnessState: snapshot?.freshness ?? 'unknown',
    sourceHealth: snapshot?.health ?? 'unknown',
    loading,
    error,
    start,
    stop,
  }
}
