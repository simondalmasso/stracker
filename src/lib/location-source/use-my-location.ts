'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocationSnapshot, MyLocationState } from './contracts'
import { freshnessFromTimestamp } from './contracts'

const LAST_LOCATION_KEY = 'stracker.lastMyLocation.v1'

function restoreLastLocation(): LocationSnapshot | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LAST_LOCATION_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<LocationSnapshot>
    const capturedMs = typeof value.capturedAt === 'string' ? Date.parse(value.capturedAt) : NaN
    if (
      value.source !== 'my-device' ||
      typeof value.lat !== 'number' ||
      !Number.isFinite(value.lat) ||
      value.lat < -90 || value.lat > 90 ||
      typeof value.lng !== 'number' ||
      !Number.isFinite(value.lng) ||
      value.lng < -180 || value.lng > 180 ||
      !Number.isFinite(capturedMs) ||
      capturedMs > Date.now() + 5 * 60 * 1000
    ) {
      window.localStorage.removeItem(LAST_LOCATION_KEY)
      return null
    }
    return {
      source: 'my-device',
      lat: value.lat,
      lng: value.lng,
      accuracyM: typeof value.accuracyM === 'number' && Number.isFinite(value.accuracyM) ? value.accuracyM : null,
      capturedAt: new Date(capturedMs).toISOString(),
      receivedAt: new Date().toISOString(),
      freshness: freshnessFromTimestamp(new Date(capturedMs).toISOString()),
    }
  } catch {
    return null
  }
}

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
  const [initialSnapshot] = useState<LocationSnapshot | null>(() => restoreLastLocation())
  const [state, setState] = useState<MyLocationState>(() => initialSnapshot ? 'MY_LOCATION_READY' : 'MY_LOCATION_IDLE')
  const [snapshot, setSnapshot] = useState<LocationSnapshot | null>(initialSnapshot)
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

  useEffect(() => {
    if (!snapshot || typeof window === 'undefined') return
    try {
      window.localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify(snapshot))
    } catch {
      // Storage can be disabled or full; live location still works.
    }
  }, [snapshot])

  const requestPermission = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setState('MY_LOCATION_UNAVAILABLE')
      return
    }

    stop()
    setState('MY_LOCATION_REQUESTING_PERMISSION')

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
