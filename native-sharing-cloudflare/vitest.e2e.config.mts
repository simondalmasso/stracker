import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './native-sharing-cloudflare/wrangler.jsonc' },
      miniflare: {
        // Test-only ceiling for the bundled workerd binary; production remains defined by wrangler.jsonc.
        compatibilityDate: '2026-07-02',
        durableObjects: {
          NATIVE_SHARING: {
            className: 'NativeSharingDurableObject',
            useSQLite: true,
          },
        },
      },
    }),
  ],
  test: {
    include: ['tests/native-sharing-cloudflare/worker-sqlite-e2e.test.ts'],
    testTimeout: 45_000,
  },
})
