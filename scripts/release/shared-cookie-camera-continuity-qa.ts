import { unlink } from 'node:fs/promises'
import { join } from 'node:path'

const source = join(process.cwd(), 'scripts/release/shared-cookie-camera-continuity-base.ts')
const runtime = join(process.cwd(), 'scripts/release/.order002-shared-cookie-camera-continuity-runtime.ts')
const patcher = join(process.cwd(), 'scripts/release/materialize-order002-shared-camera-fallback.py')

const materialize = Bun.spawnSync(['python', patcher, source, runtime], {
  cwd: process.cwd(),
  env: process.env,
  stdout: 'inherit',
  stderr: 'inherit',
})
if (materialize.exitCode !== 0) throw new Error(`ORDER002_SHARED_CAMERA_MATERIALIZATION_FAILED_${materialize.exitCode}`)

try {
  const smoke = Bun.spawnSync([process.execPath, runtime], {
    cwd: process.cwd(),
    env: process.env,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (smoke.exitCode !== 0) throw new Error(`ORDER002_SHARED_CAMERA_SMOKE_FAILED_${smoke.exitCode}`)
} finally {
  await unlink(runtime).catch(() => undefined)
}
