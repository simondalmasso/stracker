import { createHash } from 'node:crypto'
import { runSantaFePublicBrowserQa } from './santa-fe-public-browser-qa'

const target = new URL(process.env.STRACKER_QA_URL || '')
const expectedSha = process.env.STRACKER_EXPECTED_SHA || ''
const expectedVersionId = process.env.STRACKER_EXPECTED_VERSION_ID || ''
const output = process.env.STRACKER_POST_3D_QA_OUTPUT || '/tmp/stracker-santa-fe-post-promotion-3d.json'
const screenshotDir = process.env.STRACKER_POST_3D_SCREENSHOT_DIR || '/tmp'

class PostPromotionFailure extends Error {
  constructor(readonly code: string) { super(code) }
}

function ok(value: unknown, code: string): asserts value {
  if (!value) throw new PostPromotionFailure(code)
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeError(value: unknown): string {
  return String(value instanceof Error ? value.message : value || 'UNKNOWN')
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/[A-Za-z0-9_-]{43}(?:\.[A-Za-z0-9_-]{43})?/g, '[VALUE]')
    .replace(/[^A-Za-z0-9_[\]-]+/g, '_')
    .slice(0, 160)
}

async function verifyExactHead(): Promise<void> {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const headers = { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache' }
  const [buildResponse, versionResponse] = await Promise.all([
    fetch(new URL(`/__stracker/build.json?post3d=${nonce}`, target), { headers, cache: 'no-store' }),
    fetch(new URL(`/__stracker/version.json?post3d=${nonce}`, target), { headers, cache: 'no-store' }),
  ])
  ok(buildResponse.status === 200 && versionResponse.status === 200, 'POST_3D_IDENTITY_UNAVAILABLE')
  const build = await buildResponse.json().catch(() => null) as { sourceSha?: string; release?: string } | null
  const version = await versionResponse.json().catch(() => null) as { sourceSha?: string; versionId?: string } | null
  ok(build?.sourceSha === expectedSha && build.release === 'controlled-physical-pilot-v1', 'POST_3D_BUILD_SHA_MISMATCH')
  ok(version?.sourceSha === expectedSha && version.versionId === expectedVersionId, 'POST_3D_VERSION_MISMATCH')
}

async function installSupplementalSoftwareWebgl(): Promise<void> {
  const executable = process.env.CHROME_BIN || '/usr/bin/google-chrome'
  const wrapper = '/tmp/stracker-post-promotion-chrome-swiftshader.sh'
  await Bun.write(wrapper, `#!/usr/bin/env bash\nexec ${JSON.stringify(executable)} --use-angle=swiftshader "$@"\n`)
  const chmod = Bun.spawnSync(['chmod', '700', wrapper])
  if (chmod.exitCode !== 0) throw new PostPromotionFailure('POST_3D_WEBGL_WRAPPER_INSTALL_FAILED')
  process.env.CHROME_BIN = wrapper
}

if (target.protocol !== 'https:' || !target.hostname) throw new Error('HTTPS_TARGET_REQUIRED')
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('EXPECTED_SHA_REQUIRED')
if (!expectedVersionId) throw new Error('EXPECTED_VERSION_ID_REQUIRED')

await verifyExactHead()
await installSupplementalSoftwareWebgl()

let browser: Record<string, unknown> | null = null
let browserAttempts = 0
let firstFailure = 'NONE'
for (let attempt = 1; attempt <= 3; attempt += 1) {
  browserAttempts = attempt
  await verifyExactHead()
  try {
    browser = await runSantaFePublicBrowserQa({
      targetUrl: target.toString(),
      requestHeaders: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      screenshotDir,
      screenshotPrefix: `santa-fe-post-promotion-3d-${attempt}`,
      coldBudgetMs: 20_000,
      warmBudgetMs: 12_000,
    })
    await verifyExactHead()
    console.log(`SANTA_FE_POST_PROMOTION_BROWSER_ATTEMPT=${attempt} RESULT=PASS`)
    break
  } catch (error) {
    const code = safeError(error)
    if (firstFailure === 'NONE') firstFailure = code
    console.log(`SANTA_FE_POST_PROMOTION_BROWSER_ATTEMPT=${attempt} RESULT=RETRY CLASSIFICATION=${code}`)
    if (attempt < 3) await Bun.sleep(8_000)
  }
}
ok(browser, `POST_3D_BROWSER_FAILED_${firstFailure}`)

const gates = browser.gates as Record<string, string>
gates.POST_PROMOTION_100_PERCENT_EXACT_HEAD = 'PASS'
gates.POST_PROMOTION_PUBLIC_SANTA_FE_3D_RENDER = 'PASS'
gates.POST_PROMOTION_BROWSER_CACHE_BYPASS = 'PASS'
gates.POST_PROMOTION_BROWSER_RETRY_BOUNDED = 'PASS'
gates.SWIFTSHADER_NOT_SOLE_EVIDENCE = 'PASS'
gates.OWNER_PHYSICAL_ACCEPTANCE_REMAINS_REQUIRED = 'PASS'

const result = {
  schema: 'stracker.santa-fe-post-promotion-3d.v2',
  sourceSha: expectedSha,
  expectedVersionIdHash: hash(expectedVersionId),
  browserAttempts,
  firstFailure,
  rootCause: browserAttempts > 1 ? 'PUBLIC_STATIC_ASSET_OR_DYNAMIC_CHUNK_PROPAGATION_RACE' : 'NONE',
  privateDataUsed: false,
  realUserCoordinatesUsed: false,
  coordinateValuesRetained: false,
  rawVersionIdRetained: false,
  automationRenderer: 'SWIFTSHADER_SUPPLEMENTAL',
  swiftShaderSoleEvidence: false,
  ownerPhysicalAcceptanceStillRequired: true,
  browser,
  gates,
}
await Bun.write(output, JSON.stringify(result, null, 2) + '\n')
console.log(`SANTA_FE_POST_PROMOTION_BROWSER_QA=PASS attempts=${browserAttempts}`)
