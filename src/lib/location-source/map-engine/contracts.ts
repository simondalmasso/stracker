import type {
  CameraMode,
  FreshnessState,
  GeoPoint,
  GhostRailSegment,
  LocationSource,
  MotionState,
  SourceHealth,
} from '../contracts'

export interface MapRenderState {
  source: LocationSource
  point: GeoPoint
  accuracyM: number | null
  ghostrail: GhostRailSegment[]
  motion: MotionState
  freshness: FreshnessState
  health: SourceHealth
  headingDeg: number | null
  railVisible: boolean
  buildings3d: boolean
  reducedMotion: boolean
}

export interface MapPerformanceSnapshot {
  engine: 'maplibre'
  createdAtMs: number
  firstMapVisibleMs: number | null
  firstInteractiveMs: number | null
  renderFrames: number
  estimatedFps: number | null
  longTasks: number
  longTaskDurationMs: number
  webglContextLosses: number
  webglContextRestores: number
  resourceCount: number
  transferredBytes: number
}

export interface MapEngineCallbacks {
  onManualInteraction: () => void
  onWebglContextLost: () => void
  onWebglContextRestored: () => void
  onPerformance: (snapshot: MapPerformanceSnapshot) => void
}

export interface CameraUpdate {
  mode: CameraMode
  center: GeoPoint
  zoom: number
  pitchDeg: number
  bearingDeg: number | null
  offsetYRatio: number
  durationMs: number
  animate: boolean
  shouldMove: boolean
}

export interface MapEngineAdapter {
  readonly id: 'maplibre'
  mount(container: HTMLElement, initial: MapRenderState, callbacks: MapEngineCallbacks): void
  render(state: MapRenderState): void
  updateCamera(update: CameraUpdate): void
  resize(): void
  destroy(): void
}
