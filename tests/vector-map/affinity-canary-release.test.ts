import { describe, expect, test } from 'bun:test'
import manifest from '../../public/data/santa-fe-3d/manifest.json'

describe('Santa Fe affinity canary release contract', () => {
  test('keeps dense PMTiles on direct static asset routing', async () => {
    const config = await Bun.file('native-sharing-cloudflare/wrangler.release.jsonc').json()
    const routes = config.assets?.run_worker_first || []
    expect(routes.some((route: string) => route.startsWith('/data/santa-fe-3d'))).toBe(false)
    expect(manifest.asset_paths.length).toBeGreaterThanOrEqual(2)
  })

  test('uses zero, one-percent affinity canary, then full promotion', async () => {
    const release = await Bun.file('scripts/release/cloudflare-controlled-physical-pilot-release.sh').text()
    expect(release).toContain('${CANDIDATE_VERSION}@0%')
    expect(release).toContain('${CANDIDATE_VERSION}@1%')
    expect(release).toContain('${CANDIDATE_VERSION}@100%')
    expect(release).toContain('santa-fe-affinity-canary-qa.ts')
    expect(release.indexOf('${CANDIDATE_VERSION}@1%')).toBeLessThan(release.indexOf('${CANDIDATE_VERSION}@100%'))
  })
})
