'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocationSnapshot, MyLocationState } from './contracts'
import { freshnessFromTimestamp } from './contracts'

interface MyLocationController {
  state: MyLocationState
  snapshot: LocationSnapshot | null
  tracking: boolean
  requestPermission: () => void
  stop: () => void
}

function stateFromError(error: GeolocationPositionError): MyLocationState {
  if (error.code === error.PERMISSION_DENIED) return 'MY_LOCATION_PERMISSION_DENIED'
  if (error.code === error.POSITION_UNAVAILABLE) return 'MY_LOCATION_UNAVAILABLE'
  if (error.code === error.TIMEOUT) return 'MY_LOCATION_TIMEOUT'
  return 'MY_LOCATION_ERROR'
}

export function useMyLocation(): MyLocationController {
  const [state, setState] = useState<MyLocationState>('MY_LOCATION_IDLE')
  const [snapshot, setSnapshot] = useState<LocationSnapshot | null>(null)
  const [tracking, setTracking] = useState(false)
  const watchIdRef = useRef<number | null>(null)
  const freshnessTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stop = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== 'undefined') {
      navigator.geolocation.clearWatch(watchIdRef.current)
    }
    watchIdRef.current = null
    setTracking(false)
    if (freshnessTimerRef.current) clearInterval(freshnessTimerRef.current)
    freshnessTimerRef.current = null
  }, [])

  useEffect(() => stop, [stop])

  const requestPermission = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState('MY_LOCATION_UNAVAILABLE')
      return
    }

    stop()
    setState('MY_LOCATION_REQUESTING_PERMISSION')
    setSnapshot(null)

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const capturedAt = new Date(position.timestamp).toISOString()
        const next: LocationSnapshot = {
          source: 'my-device',
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracyM: Number.isFinite(position.coords.accuracy)
            ? position.coords.accuracy
            : null,
          capturedAt,
          receivedAt: new Date().toISOString(),
          freshness: freshnessFromTimestamp(capturedAt),
        }
        setSnapshot(next)
        setState('MY_LOCATION_READY')
        setTracking(true)
      },
      (error) => {
        setState(stateFromError(error))
        setTracking(false)
      },
      {
        enableHighAccuracy: true,
        maximumAge: 15_000,
        timeout: 20_000,
      },
    )

    freshnessTimerRef.current = setInterval(() => {
      setSnapshot((current) =>
        current
          ? {
              ...current,
              freshness: freshnessFromTimestamp(current.capturedAt),
            }
          : current,
      )
    }, 5_000)
  }, [stop])

  return { state, snapshot, tracking, requestPermission, stop }
}
