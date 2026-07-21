'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FreshnessState,
  GhostRailSegment,
  LocationSample,
  LocationSnapshot,
  MotionState,
  MyLocationState,
  SourceHealth,
} from './contracts'
import {
  initialLocationPipelineState,
  processLocationSample,
  recordPipelineError,
  refreshPipelineTime,
  type LocationPipelineState,
} from './location-pipeline'

interface MyLocationController {
  state: MyLocationState
  snapshot: LocationSnapshot | null
  ghostrail: GhostRailSegment[]
  tracking: boolean
  motionState: MotionState
  freshnessState: FreshnessState
  sourceHealth: SourceHealth
  requestPermission: () => void
  stop: () => void
}

function stateFromError(error: GeolocationPositionError): MyLocationState {
  if (error.code === error.PERMISSION_DENIED) return 'MY_LOCATION_PERMISSION_DENIED'
  if (error.code === error.POSITION_UNAVAILABLE) return 'MY_LOCATION_UNAVAILABLE'
  if (error.code === error.TIMEOUT) return 'MY_LOCATION_TIMEOUT'
  return 'MY_LOCATION_ERROR'
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null
}

export function useMyLocation(): MyLocationController {
  const [state, setState] = useState<MyLocationState>('MY_LOCATION_IDLE')
  const [snapshot, setSnapshot] = useState<LocationSnapshot | null>(null)
  const [ghostrail, setGhostrail] = useState<GhostRailSegment[]>([])
  const [tracking, setTracking] = useState(false)
  const watchIdRef = useRef<number | null>(null)
  const freshnessTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const generationRef = useRef(0)
  const pipelineRef = useRef<LocationPipelineState>(initialLocationPipelineState('my-device'))

  const abortOnly = useCallback(() => {
    generationRef.current += 1
    if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current)
    }
    watchIdRef.current = null
    if (freshnessTimerRef.current) clearInterval(freshnessTimerRef.current)
    freshnessTimerRef.current = null
  }, [])

  const stop = useCallback(() => {
    abortOnly()
    pipelineRef.current = initialLocationPipelineState('my-device', pipelineRef.current.sessionEpoch + 1)
    setTracking(false)
    setSnapshot(null)
    setGhostrail([])
    setState('MY_LOCATION_IDLE')
  }, [abortOnly])

  useEffect(() => () => abortOnly(), [abortOnly])

  const requestPermission = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState('MY_LOCATION_UNAVAILABLE')
      return
    }

    abortOnly()
    pipelineRef.current = initialLocationPipelineState('my-device', pipelineRef.current.sessionEpoch + 1)
    const generation = generationRef.current
    setState('MY_LOCATION_REQUESTING_PERMISSION')
    setSnapshot(null)
    setGhostrail([])
    setTracking(false)

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        if (generation !== generationRef.current) return
        const capturedMs = Number.isFinite(position.timestamp) && position.timestamp > 0
          ? position.timestamp
          : Date.now()
        const sample: LocationSample = {
          source: 'my-device',
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracyM: finiteOrNull(position.coords.accuracy),
          capturedAt: new Date(capturedMs).toISOString(),
          receivedAt: new Date().toISOString(),
          speedMps: finiteOrNull(position.coords.speed),
          headingDeg: finiteOrNull(position.coords.heading),
        }
        const result = processLocationSample(pipelineRef.current, sample, 'not-applicable')
        pipelineRef.current = result.state
        setSnapshot(result.snapshot)
        setGhostrail(result.ghostrail)
        if (result.snapshot) {
          setState('MY_LOCATION_READY')
          setTracking(true)
        }
      },
      (error) => {
        if (generation !== generationRef.current) return
        pipelineRef.current = recordPipelineError(pipelineRef.current)
        setSnapshot(pipelineRef.current.latest)
        setState(stateFromError(error))
        setTracking(false)
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5_000,
        timeout: 20_000,
      },
    )

    freshnessTimerRef.current = setInterval(() => {
      if (generation !== generationRef.current) return
      pipelineRef.current = refreshPipelineTime(pipelineRef.current, 'not-applicable')
      setSnapshot(pipelineRef.current.latest)
    }, 5_000)
  }, [abortOnly])

  return {
    state,
    snapshot,
    ghostrail,
    tracking,
    motionState: snapshot?.motion ?? 'unknown',
    freshnessState: snapshot?.freshness ?? 'unknown',
    sourceHealth: snapshot?.health ?? 'unknown',
    requestPermission,
    stop,
  }
}
