import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './native-sharing-cloudflare/wrangler.jsonc' },
      miniflare: { compatibilityDate: '2026-07-02' },
    }),
  ],
  test: {
    include: ['tests/native-sharing-cloudflare/workerd-atomicity.test.ts'],
    testTimeout: 30_000,
  },
})
