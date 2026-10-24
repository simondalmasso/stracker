import { describe, expect, test } from 'bun:test'

describe('Cloudflare Static Assets owns the Santa Fe PMTiles byte-range route', () => {
  test('does not route PMTiles archives through the Worker-first pipeline', async () => {
    const config = JSON.parse(await Bun.file('native-sharing-cloudflare/wrangler.release.jsonc').text()) as {
      assets?: { run_worker_first?: string[] }
    expect(config.assets?.run_worker_first).not.toContain('/data/santa-fe-3d/*.pmtiles')
  })

  test('marks native byte-range responses without proxying or materializing the archive', async () => {
    const headers = await Bun.file('public/_headers').text()
    expect(headers).toContain('/data/santa-fe-3d/*.pmtiles')
    expect(headers).toContain('X-Stracker-PMTiles-Transport: query-v1')
    const publicWorker = await Bun.file('native-sharing-cloudflare/src/public-worker.ts').text()
    const minimalWorker = await Bun.file('native-sharing-cloudflare/src/minimal-worker.ts').text()
    expect(publicWorker).not.toContain('servePmtilesNativeRange')
    expect(minimalWorker).not.toContain('loadPmtilesAsset')
    expect(minimalWorker).not.toContain('PMTILES_MAX_ARCHIVE_BYTES')
  })
})
