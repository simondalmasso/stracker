import { describe, expect, test } from 'bun:test'
import { SANTA_FE_3D_ASSET_PATHS, SANTA_FE_3D_SOURCE_LAYER } from '../../src/lib/location-source/map-engine/santa-fe-3d-generated'
import {
  SANTA_FE_3D_LAYER_IDS,
  SANTA_FE_3D_PUBLIC_FIXTURES,
  SANTA_FE_3D_SOURCE_IDS,
  isInsideSantaFe3dBounds,
  sameOriginPmtilesUrl,
  santaFe3dLayerDefinition,
  santaFe3dManifestContract,
  santaFe3dSourceDefinition,
} from '../../src/lib/location-source/map-engine/santa-fe-city-config'

describe('Santa Fe dense city 3D contract', () => {
  test('uses content-addressed same-origin PMTiles shards', () => {
    expect(SANTA_FE_3D_ASSET_PATHS.length).toBeGreaterThanOrEqual(2)
    expect(new Set(SANTA_FE_3D_ASSET_PATHS).size).toBe(SANTA_FE_3D_ASSET_PATHS.length)
    expect(new Set(SANTA_FE_3D_SOURCE_IDS).size).toBe(SANTA_FE_3D_ASSET_PATHS.length)
    expect(new Set(SANTA_FE_3D_LAYER_IDS).size).toBe(SANTA_FE_3D_ASSET_PATHS.length)
    for (const path of SANTA_FE_3D_ASSET_PATHS) {
      expect(path).toMatch(/^\/data\/santa-fe-3d\/santa-fe-buildings-3d-[a-z-]+\.[a-f0-9]{16}\.pmtiles$/)
      expect(sameOriginPmtilesUrl(path, 'https://stracker.example')).toBe(`pmtiles://https://stracker.example${path}`)
      expect(santaFe3dSourceDefinition(path, 'https://stracker.example').url).toContain('pmtiles://https://stracker.example/')
    }
  })

  test('keeps fixtures public and inside the versioned city boundary', () => {
    for (const fixture of SANTA_FE_3D_PUBLIC_FIXTURES) {
      expect(isInsideSantaFe3dBounds(fixture)).toBe(true)
      expect(fixture.pitch).toBeGreaterThanOrEqual(52)
      expect(fixture.pitch).toBeLessThanOrEqual(60)
      expect(fixture.zoom).toBeGreaterThanOrEqual(16.3)
      expect(fixture.zoom).toBeLessThanOrEqual(17.5)
    }
    expect(isInsideSantaFe3dBounds({ lng: -58.38, lat: -34.60 })).toBe(false)
  })

  test('creates light, height-varying extrusion layers below labels', () => {
    const layer = santaFe3dLayerDefinition('source', 'layer', 'full')
    expect(layer.type).toBe('fill-extrusion')
    expect(layer['source-layer']).toBe(SANTA_FE_3D_SOURCE_LAYER)
    expect(layer.layout?.visibility).toBe('none')
    expect(layer.paint?.['fill-extrusion-vertical-gradient']).toBe(true)
    expect(JSON.stringify(layer.paint?.['fill-extrusion-color'])).toContain('#e6e7e3')
    expect(JSON.stringify(layer.paint?.['fill-extrusion-height'])).toContain('height')
  })

  test('materialized dataset is dense and has a stable source layer', () => {
    const contract = santaFe3dManifestContract()
    expect(contract.featureCount).toBeGreaterThan(200_000)
    expect(contract.assetCount).toBe(SANTA_FE_3D_ASSET_PATHS.length)
    expect(contract.sourceLayer).toBe('santa_fe_buildings_3d')
  })
})
