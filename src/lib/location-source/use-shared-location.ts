'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FreshnessState,
  GhostRailSegment,
  LocationSample,
  LocationSnapshot,
  MotionState,
  SharedLocationState,
  SharedSessionState,
  SharedSessionStatus,
  SourceHealth,
} from './contracts'
import { sharedSessionStateFromStatus } from './contracts'
import {
  initialLocationPipelineState,
  processLocationSample,
  recordPipelineError,
  refreshPipelineTime,
  replacePipelineSession,
  type LocationPipelineState,
} from './location-pipeline'
import {
  deleteSharedSession,
  fetchSharedPoints,
  getSharedSessionStatus,
  importSharedSession,
  SessionApiError,
} from './session-api'

interface SharedLocationController {
  state: SharedLocationState
  sessionState: SharedSessionState
  status: SharedSessionStatus | null
  snapshot: LocationSnapshot | null
  ghostrail: GhostRailSegment[]
  motionState: MotionState
  freshnessState: FreshnessState
  sourceHealth: SourceHealth
  loading: boolean
  error: string | null
  refreshStatus: () => Promise<void>
  importSession: (raw: string) => Promise<SharedSessionStatus>
  deleteSession: () => Promise<void>
  startPolling: () => void
  stop: () => void
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function toSharedSample(record: Record<string, unknown>, fallbackTimestamp: string | null): LocationSample | null {
  const lat = numberField(record, 'lat')
  const lng = numberField(record, 'lng')
  const capturedAt = stringField(record, ['timestamp', 'captured_at', 'capturedAt', 'ts']) || fallbackTimestamp
  if (lat === null || lng === null || !capturedAt || !Number.isFinite(Date.parse(capturedAt))) return null
  return {
    source: 'google-shared',
    lat,
    lng,
    accuracyM: numberField(record, 'accuracy') ?? numberField(record, 'accuracy_m'),
    capturedAt,
    receivedAt: new Date().toISOString(),
    speedMps: numberField(record, 'speed') ?? numberField(record, 'speed_mps'),
    headingDeg: numberField(record, 'heading') ?? numberField(record, 'heading_deg'),
  }
}

function userMessage(error: unknown): string {
  if (error instanceof SessionApiError) return error.message
  if (error instanceof Error) return error.message
  return 'No se pudo completar la operación.'
}

function aggregateState(snapshot: LocationSnapshot | null): SharedLocationState {
  if (!snapshot) return 'SHARED_NO_LOCATION'
  return snapshot.freshness === 'fresh' ? 'SHARED_READY' : 'SHARED_STALE'
}

export function useSharedLocation(): SharedLocationController {
  const [state, setState] = useState<SharedLocationState>('SHARED_UNCONFIGURED')
  const [sessionState, setSessionState] = useState<SharedSessionState>('unconfigured')
  const [status, setStatus] = useState<SharedSessionStatus | null>(null)
  const [snapshot, setSnapshot] = useState<LocationSnapshot | null>(null)
  const [ghostrail, setGhostrail] = useState<GhostRailSegment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const freshnessTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)
  const sessionStateRef = useRef<SharedSessionState>('unconfigured')
  const pipelineRef = useRef<LocationPipelineState>(initialLocationPipelineState('google-shared'))

  const setExactSessionState = useCallback((next: SharedSessionState) => {
    sessionStateRef.current = next
    setSessionState(next)
  }, [])

  const abortTransport = useCallback(() => {
    generationRef.current += 1
    if (pollRef.current) clearInterval(pollRef.current)
    if (freshnessTimerRef.current) clearInterval(freshnessTimerRef.current)
    pollRef.current = null
    freshnessTimerRef.current = null
    requestRef.current?.abort()
    requestRef.current = null
  }, [])

  const stop = useCallback(() => {
    abortTransport()
    pipelineRef.current = initialLocationPipelineState('google-shared', pipelineRef.current.sessionEpoch + 1)
    setStatus(null)
    setSnapshot(null)
    setGhostrail([])
    setError(null)
    setLoading(false)
    setState('SHARED_UNCONFIGURED')
    setExactSessionState('unconfigured')
  }, [abortTransport, setExactSessionState])

  useEffect(() => () => abortTransport(), [abortTransport])

  const loadPoints = useCallback(async (generation: number) => {
    const controller = new AbortController()
    requestRef.current?.abort()
    requestRef.current = controller
    try {
      const payload = await fetchSharedPoints(controller.signal)
      if (generation !== generationRef.current || controller.signal.aborted) return
      const fallbackTimestamp = typeof payload.last_update === 'string' ? payload.last_update : null
      const rawPoints = Array.isArray(payload.points) ? payload.points : []
      const samples = rawPoints
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => toSharedSample(item, fallbackTimestamp))
        .filter((item): item is LocationSample => item !== null)
        .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt))

      for (const sample of samples) {
        const result = processLocationSample(pipelineRef.current, sample, sessionStateRef.current)
        pipelineRef.current = result.state
      }
      if (generation !== generationRef.current) return
      const latest = pipelineRef.current.latest
      setSnapshot(latest)
      setGhostrail(pipelineRef.current.rail.segments)
      setError(null)
      setState(aggregateState(latest))
    } catch (caught) {
      if (generation !== generationRef.current || controller.signal.aborted) return
      pipelineRef.current = recordPipelineError(pipelineRef.current)
      setSnapshot(pipelineRef.current.latest)
      setGhostrail(pipelineRef.current.rail.segments)
      if (caught instanceof SessionApiError && caught.status === 401) {
        setState('SHARED_EXPIRED')
        setExactSessionState('expired')
      } else {
        setState('SHARED_ERROR')
        setExactSessionState('upstream-error')
      }
      setError(userMessage(caught))
    }
  }, [setExactSessionState])

  const startPolling = useCallback(() => {
    abortTransport()
    const generation = generationRef.current
    void loadPoints(generation)
    pollRef.current = setInterval(() => void loadPoints(generation), 20_000)
    freshnessTimerRef.current = setInterval(() => {
      if (generation !== generationRef.current) return
      pipelineRef.current = refreshPipelineTime(pipelineRef.current, sessionStateRef.current)
      setSnapshot(pipelineRef.current.latest)
      setGhostrail(pipelineRef.current.rail.segments)
      setState(aggregateState(pipelineRef.current.latest))
    }, 5_000)
  }, [abortTransport, loadPoints])

  const refreshStatus = useCallback(async () => {
    abortTransport()
    const generation = generationRef.current
    setLoading(true)
    setError(null)
    setExactSessionState('validating')
    const controller = new AbortController()
    requestRef.current = controller
    try {
      const next = await getSharedSessionStatus(controller.signal)
      if (generation !== generationRef.current || controller.signal.aborted) return
      setStatus(next)
      setState(next.state)
      const exact = sharedSessionStateFromStatus(next)
      setExactSessionState(exact)
      if (exact === 'valid') startPolling()
    } catch (caught) {
      if (generation !== generationRef.current || controller.signal.aborted) return
      setState('SHARED_ERROR')
      setExactSessionState('upstream-error')
      setError(userMessage(caught))
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }, [abortTransport, setExactSessionState, startPolling])

  const importSession = useCallback(async (raw: string): Promise<SharedSessionStatus> => {
    abortTransport()
    const generation = generationRef.current
    setLoading(true)
    setError(null)
    setState('SHARED_VALIDATING')
    setExactSessionState('validating')
    const controller = new AbortController()
    requestRef.current = controller
    try {
      const result = await importSharedSession(raw, controller.signal)
      if (generation !== generationRef.current || controller.signal.aborted) return result
      setStatus(result)
      setState(result.state)
      const exact = sharedSessionStateFromStatus(result)
      setExactSessionState(exact)
      if (exact === 'valid') {
        pipelineRef.current = replacePipelineSession(pipelineRef.current)
        setSnapshot(null)
        setGhostrail([])
        startPolling()
      }
      return result
    } catch (caught) {
      if (generation === generationRef.current && !controller.signal.aborted) {
        setState('SHARED_ERROR')
        setExactSessionState(caught instanceof SessionApiError && caught.status === 401 ? 'expired' : 'rejected')
        setError(userMessage(caught))
      }
      throw caught
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }, [abortTransport, setExactSessionState, startPolling])

  const deleteSession = useCallback(async () => {
    abortTransport()
    const generation = generationRef.current
    setLoading(true)
    setError(null)
    const controller = new AbortController()
    requestRef.current = controller
    try {
      await deleteSharedSession(controller.signal)
      if (generation !== generationRef.current || controller.signal.aborted) return
      pipelineRef.current = replacePipelineSession(pipelineRef.current)
      setStatus(null)
      setSnapshot(null)
      setGhostrail([])
      setState('SHARED_UNCONFIGURED')
      setExactSessionState('unconfigured')
    } catch (caught) {
      if (generation !== generationRef.current || controller.signal.aborted) return
      setState('SHARED_ERROR')
      setExactSessionState('upstream-error')
      setError(userMessage(caught))
      throw caught
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }, [abortTransport, setExactSessionState])

  return {
    state,
    sessionState,
    status,
    snapshot,
    ghostrail,
    motionState: snapshot?.motion ?? 'unknown',
    freshnessState: snapshot?.freshness ?? 'unknown',
    sourceHealth: snapshot?.health ?? 'unknown',
    loading,
    error,
    refreshStatus,
    importSession,
    deleteSession,
    startPolling,
    stop,
  }
}
