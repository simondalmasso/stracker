import type { CameraMode, MotionState } from './contracts'
import { clamp, smoothBearing } from './geo'

export const MAP_PERSPECTIVE_PITCH_DEG = 56

export interface CameraControllerState {
  mode: CameraMode
  bearingDeg: number | null
}

export interface CameraControllerInput {
  current: CameraControllerState
  motion: MotionState
  hasPoint: boolean
  userInteracted?: boolean
  recenter?: boolean
  measuredBearingDeg?: number | null
  reducedMotion?: boolean
}

export interface CameraPlan {
  state: CameraControllerState
  pitchDeg: number
  zoom: number
  offsetYRatio: number
  durationMs: number
  animate: boolean
  shouldMove: boolean
}

export function initialCameraControllerState(): CameraControllerState {
  return { mode: 'overview', bearingDeg: null }
}

function automaticMode(motion: MotionState, hasPoint: boolean): CameraMode {
  if (!hasPoint || motion === 'unknown') return 'overview'
  return motion === 'moving' ? 'follow' : 'stationary'
}

export function planCamera(input: CameraControllerInput): CameraPlan {
  let mode = input.current.mode
  if (input.userInteracted) mode = 'manual'
  else if (input.recenter) mode = automaticMode(input.motion, input.hasPoint)
  else if (mode !== 'manual') mode = automaticMode(input.motion, input.hasPoint)

  const nextBearing = input.measuredBearingDeg === null || input.measuredBearingDeg === undefined
    ? input.current.bearingDeg
    : smoothBearing(input.current.bearingDeg, input.measuredBearingDeg)
  const reduced = Boolean(input.reducedMotion)

  if (mode === 'manual') {
    return {
      state: { mode, bearingDeg: nextBearing },
      pitchDeg: 0,
      zoom: 0,
      offsetYRatio: 0,
      durationMs: 0,
      animate: false,
      shouldMove: false,
    }
  }

  if (mode === 'follow') {
    return {
      state: { mode, bearingDeg: nextBearing },
      pitchDeg: reduced ? MAP_PERSPECTIVE_PITCH_DEG : 60,
      zoom: 17.4,
      offsetYRatio: reduced ? 0.08 : 0.18,
      durationMs: reduced ? 0 : 650,
      animate: !reduced,
      shouldMove: true,
    }
  }

  if (mode === 'stationary') {
    return {
      state: { mode, bearingDeg: nextBearing },
      pitchDeg: MAP_PERSPECTIVE_PITCH_DEG,
      zoom: 17,
      offsetYRatio: 0,
      durationMs: reduced ? 0 : 350,
      animate: !reduced,
      shouldMove: input.current.mode !== 'stationary' || Boolean(input.recenter),
    }
  }

  return {
    state: { mode: 'overview', bearingDeg: nextBearing },
    pitchDeg: input.hasPoint ? MAP_PERSPECTIVE_PITCH_DEG : 0,
    zoom: input.hasPoint ? 16.3 : 4,
    offsetYRatio: 0,
    durationMs: reduced ? 0 : 350,
    animate: !reduced,
    shouldMove: input.hasPoint && (input.current.mode !== 'overview' || Boolean(input.recenter)),
  }
}

export function fallbackPitch(currentPitch: number, recoveryAttempt: number): number {
  if (recoveryAttempt <= 0) return clamp(currentPitch, 0, 65)
  if (recoveryAttempt === 1) return Math.min(currentPitch, 40)
  return 0
}
