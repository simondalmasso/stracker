import './public-pmtiles-native-range.test'
import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

interface WorkerConfig {
  name?: string
  main?: string
  workers_dev?: boolean
  preview_urls?: boolean
  routes?: unknown[]
  route?: unknown
  account_id?: unknown
  zone_id?: unknown
  assets?: {
    binding?: string
    run_worker_first?: string[]
  }
  services?: Array<{ binding?: string; service?: string; environment?: string }>
  version_metadata?: { binding?: string }
  durable_objects?: {
    bindings?: Array<{ name?: string; class_name?: string; script_name?: string }>
  }
  exports?: Record<string, { type?: string; storage?: string }>
  migrations?: unknown
}

async function config(path: string): Promise<WorkerConfig> {
  return JSON.parse(await readFile(path, 'utf8')) as WorkerConfig
}

describe('live native sharing Cloudflare boundary', () => {
  test('private backend owns the only SQLite Durable Object lifecycle', async () => {
    const backend = await config('native-sharing-cloudflare/wrangler.backend.jsonc')
    expect(backend).toMatchObject({
      name: 'stracker-native-sharing-backend',
      main: 'src/index.ts',
      workers_dev: false,
      preview_urls: false,
      routes: [],
      durable_objects: {
        bindings: [{ name: 'NATIVE_SHARING', class_name: 'NativeSharingDurableObject' }],
      },
      exports: {
        NativeSharingDurableObject: { type: 'durable-object', storage: 'sqlite' },
      },
    })
    expect(backend).not.toHaveProperty('assets')
    expect(backend).not.toHaveProperty('services')
    expect(backend).not.toHaveProperty('migrations')
    expect(backend).not.toHaveProperty('route')
    expect(backend).not.toHaveProperty('account_id')
    expect(backend).not.toHaveProperty('zone_id')
  })

  test('public Worker has a single exact service binding and cookie-session API stays worker-first', async () => {
    const publicConfig = await config('native-sharing-cloudflare/wrangler.release.jsonc')
    expect(publicConfig.name).toBe('stracker')
    expect(publicConfig.workers_dev).toBe(true)
    expect(publicConfig.preview_urls).toBe(false)
    expect(publicConfig.routes).toEqual([])
    expect(publicConfig.assets?.binding).toBe('ASSETS')
    expect(publicConfig.version_metadata?.binding).toBe('CF_VERSION_METADATA')
    expect(publicConfig.services).toEqual([
      { binding: 'NATIVE_SHARING_BACKEND', service: 'stracker-native-sharing-backend' },
    ])
    expect(publicConfig.assets?.run_worker_first).toEqual(expect.arrayContaining([
      '/api/share/*',
      '/api/cookie-sessions',
      '/api/cookie-sessions/*',
      '/shared',
      '/shared/*',
      '/__stracker/version.json',
      '/__stracker/build.json',
      '/data/santa-fe-3d/*.pmtiles',
    ]))
    expect(publicConfig).not.toHaveProperty('durable_objects')
    expect(publicConfig).not.toHaveProperty('exports')
    expect(publicConfig).not.toHaveProperty('migrations')
    expect(publicConfig).not.toHaveProperty('route')
    expect(publicConfig).not.toHaveProperty('account_id')
    expect(publicConfig).not.toHaveProperty('zone_id')
  })
})
