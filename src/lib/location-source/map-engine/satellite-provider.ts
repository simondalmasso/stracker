import policy from './satellite-provider-policy.json'
import type { BasemapMode } from '../contracts'

interface SelectedSatelliteProvider {
  id: string
  role: 'AUTHORIZED_OPEN_FALLBACK'
  host: string
  tileTemplate: string
  capabilitiesUrl: string
  apiKeyRequired: false
  costUsd: 0
  paidOverageAllowed: false
  automaticUpgradeToPaid: false
  billingDependency: false
  license: string
  attribution: string
  imageryPeriod: string
  recentClaimAllowed: false
  coverage: string
  completeCoverageClaimed: false
  maxZoom: number
  resolutionMeters: number
}

export const SATELLITE_PROVIDER = policy.selectedProvider as SelectedSatelliteProvider
export const SATELLITE_SOURCE_ID = 'stracker-satellite'
export const SATELLITE_LAYER_ID = 'stracker-satellite-raster'

export function basemapLabel(mode: BasemapMode): string {
  if (mode === 'satellite') return 'SATÉLITE'
  if (mode === 'hybrid') return 'HÍBRIDO'
  return 'MAPA 3D'
}

export function usesSatelliteImagery(mode: BasemapMode): boolean {
  return mode === 'satellite' || mode === 'hybrid'
}
