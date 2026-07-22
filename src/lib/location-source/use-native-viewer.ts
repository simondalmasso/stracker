'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FreshnessState,
  GhostRailSegment,
  LocationSample,
  LocationSnapshot,
  MotionState,
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
  fetchNativeViewerPoints,
  fetchNativeViewerStatus,
  NativeSharingApiError,
  parseViewerCapability,
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
  start: (capability: string) => Promise<void>
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

  const stop = useCallback(() => {
    abortTransport()
    pipelineRef.current = initialLocationPipelineState('shared-location', pipelineRef.current.sessionEpoch + 1)
    lastSequenceRef.current = 0
    setSnapshot(null)
    setGhostrail([])
    setError(null)
    setLoading(false)
    setExactState('unconfirmed')
  }, [abortTransport, setExactState])

  useEffect(() => () => abortTransport(), [abortTransport])

  const start = useCallback(async (capability: string) => {
    abortTransport()
    pipelineRef.current = initialLocationPipelineState('shared-location', pipelineRef.current.sessionEpoch + 1)
    lastSequenceRef.current = 0
    setSnapshot(null)
    setGhostrail([])
    setError(null)
    setLoading(true)
    setExactState('validating')
    const parsed = parseViewerCapability(capability)
    if (!parsed) {
      setLoading(false)
      setExactState('invalid')
      setError('El enlace privado no es válido.')
      return
    }
    const generation = generationRef.current

    const load = async () => {
      const controller = new AbortController()
      requestRef.current?.abort()
      requestRef.current = controller
      try {
        const status = await fetchNativeViewerStatus(parsed.sessionId, parsed.viewerToken, controller.signal)
        if (generation !== generationRef.current || controller.signal.aborted) return
        setExactState(status.state)
        if (status.state === 'expired' || status.state === 'revoked' || status.state === 'invalid') {
          setLoading(false)
          return
        }
        const payload = await fetchNativeViewerPoints(parsed.sessionId, parsed.viewerToken, controller.signal)
        if (generation !== generationRef.current || controller.signal.aborted) return
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
        if (generation !== generationRef.current || controller.signal.aborted) return
        pipelineRef.current = recordPipelineError(pipelineRef.current)
        setSnapshot(pipelineRef.current.latest)
        setGhostrail(pipelineRef.current.rail.segments)
        if (caught instanceof NativeSharingApiError && caught.status === 404) setExactState('invalid')
        else if (caught instanceof NativeSharingApiError && caught.code === 'SESSION_REVOKED') setExactState('revoked')
        else if (caught instanceof NativeSharingApiError && caught.code === 'SESSION_EXPIRED') setExactState('expired')
        else setExactState('stale')
        setError(message(caught))
        setLoading(false)
      }
    }

    await load()
    if (generation !== generationRef.current || ['expired', 'revoked', 'invalid'].includes(stateRef.current)) return
    pollRef.current = setInterval(() => void load(), 10_000)
    freshnessRef.current = setInterval(() => {
      if (generation !== generationRef.current) return
      pipelineRef.current = refreshPipelineTime(pipelineRef.current, stateRef.current)
      setSnapshot(pipelineRef.current.latest)
      setGhostrail(pipelineRef.current.rail.segments)
    }, 5_000)
  }, [abortTransport, setExactState])

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
