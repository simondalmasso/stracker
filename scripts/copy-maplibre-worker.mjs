import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const workerPath = require.resolve('maplibre-gl/dist/maplibre-gl-worker.mjs')
const sourceDir = dirname(workerPath)
const destinationDir = join(process.cwd(), 'public', 'maplibre')
mkdirSync(destinationDir, { recursive: true })

for (const filename of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
  copyFileSync(join(sourceDir, filename), join(destinationDir, filename))
}

console.log('MAPLIBRE_WORKER_ASSETS=PASS')
