import { cloudflareTest } from '@cloudflare/vitest-plugin'
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
            // Validates workerd SQLite semantics only. Lifecycle exports are gated separately.
            useSQLite: true,
          },
        },
      },
    }),
  ],
  test: {
    include: ['tests/native-sharing-cloudflare/workerd-atomicity.test.ts'],
    testTimeout: 30_000,
  },
})
