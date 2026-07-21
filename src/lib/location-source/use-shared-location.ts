'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LocationSnapshot,
  SharedLocationState,
  SharedSessionStatus,
} from './contracts'
import { freshnessFromTimestamp } from './contracts'
import {
  deleteSharedSession,
  fetchSharedPoints,
  getSharedSessionStatus,
  importSharedSession,
  SessionApiError,
} from './session-api'

interface SharedLocationController {
  state: SharedLocationState
  status: SharedSessionStatus | null
  snapshot: LocationSnapshot | null
  ghostrail: LocationSnapshot[]
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

function toSharedSnapshot(record: Record<string, unknown>): LocationSnapshot | null {
  const lat = numberField(record, 'lat')
  const lng = numberField(record, 'lng')
  if (lat === null || lng === null) return null
  const capturedAt =
    stringField(record, ['timestamp', 'captured_at', 'capturedAt', 'ts']) ||
    new Date().toISOString()
  return {
    source: 'google-shared',
    lat,
    lng,
    accuracyM: numberField(record, 'accuracy') ?? numberField(record, 'accuracy_m'),
    capturedAt,
    receivedAt: new Date().toISOString(),
    freshness: freshnessFromTimestamp(capturedAt),
  }
}

function userMessage(error: unknown): string {
  if (error instanceof SessionApiError) return error.message
  if (error instanceof Error) return error.message
  return 'No se pudo completar la operación.'
}

export function useSharedLocation(): SharedLocationController {
  const [state, setState] = useState<SharedLocationState>('SHARED_UNCONFIGURED')
  const [status, setStatus] = useState<SharedSessionStatus | null>(null)
  const [snapshot, setSnapshot] = useState<LocationSnapshot | null>(null)
  const [ghostrail, setGhostrail] = useState<LocationSnapshot[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const requestRef = useRef<AbortController | null>(null)

  const stop = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = null
    requestRef.current?.abort()
    requestRef.current = null
  }, [])

  useEffect(() => stop, [stop])

  const loadPoints = useCallback(async () => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    try {
      const payload = await fetchSharedPoints(controller.signal)
      const rawPoints = Array.isArray(payload.points) ? payload.points : []
      const rawRail = Array.isArray(payload.ghostrail_pts) ? payload.ghostrail_pts : []
      const latestRaw = rawPoints.at(-1)
      const latest = latestRaw && typeof latestRaw === 'object'
        ? toSharedSnapshot(latestRaw as Record<string, unknown>)
        : null
      const rail = rawRail
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map(toSharedSnapshot)
        .filter((item): item is LocationSnapshot => item !== null)

      setGhostrail(rail)
      setSnapshot(latest)
      setError(null)
      if (!latest) {
        setState('SHARED_NO_LOCATION')
      } else if (latest.freshness === 'fresh') {
        setState('SHARED_READY')
      } else {
        setState('SHARED_STALE')
      }
    } catch (caught) {
      if (controller.signal.aborted) return
      if (caught instanceof SessionApiError && caught.status === 401) {
        setState('SHARED_EXPIRED')
      } else {
        setState('SHARED_ERROR')
      }
      setError(userMessage(caught))
    }
  }, [])

  const startPolling = useCallback(() => {
    stop()
    void loadPoints()
    pollRef.current = setInterval(() => void loadPoints(), 20_000)
  }, [loadPoints, stop])

  const refreshStatus = useCallback(async () => {
    setLoading(true)
    setError(null)
    const controller = new AbortController()
    requestRef.current = controller
    try {
      const next = await getSharedSessionStatus(controller.signal)
      setStatus(next)
      setState(next.state)
      if (
        next.state === 'SHARED_READY' ||
        next.state === 'SHARED_STALE' ||
        next.state === 'SHARED_NO_LOCATION'
      ) {
        startPolling()
      }
    } catch (caught) {
      if (controller.signal.aborted) return
      setState('SHARED_ERROR')
      setError(userMessage(caught))
    } finally {
      setLoading(false)
    }
  }, [startPolling])

  const importSession = useCallback(
    async (raw: string): Promise<SharedSessionStatus> => {
      setLoading(true)
      setError(null)
      setState('SHARED_VALIDATING')
      const controller = new AbortController()
      requestRef.current = controller
      try {
        const result = await importSharedSession(raw, controller.signal)
        setStatus(result)
        setState(result.state)
        if (
          result.state === 'SHARED_READY' ||
          result.state === 'SHARED_STALE' ||
          result.state === 'SHARED_NO_LOCATION'
        ) {
          startPolling()
        }
        return result
      } catch (caught) {
        if (!controller.signal.aborted) {
          setState('SHARED_ERROR')
          setError(userMessage(caught))
        }
        throw caught
      } finally {
        setLoading(false)
      }
    },
    [startPolling],
  )

  const deleteSession = useCallback(async () => {
    setLoading(true)
    setError(null)
    stop()
    try {
      await deleteSharedSession()
      setStatus(null)
      setSnapshot(null)
      setGhostrail([])
      setState('SHARED_UNCONFIGURED')
    } catch (caught) {
      setState('SHARED_ERROR')
      setError(userMessage(caught))
      throw caught
    } finally {
      setLoading(false)
    }
  }, [stop])

  return {
    state,
    status,
    snapshot,
    ghostrail,
    loading,
    error,
    refreshStatus,
    importSession,
    deleteSession,
    startPolling,
    stop,
  }
}
