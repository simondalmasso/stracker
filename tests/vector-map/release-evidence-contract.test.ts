import { describe, expect, test } from 'bun:test'

const wrapperPath = 'scripts/release/cloudflare-controlled-physical-pilot-release.sh'
const apiEntrypointPath = 'scripts/release/live-native-sharing-api-qa.ts'
const public3dQaPath = 'scripts/release/santa-fe-public-browser-qa.ts'

describe('release evidence and rollback contract', () => {
  test('materialized post-promotion QA is fail-fast and isolates bounded 3d proof', async () => {
    const wrapper = await Bun.file(wrapperPath).text()
    expect(wrapper).toContain('API_QA_FAIL_FAST')
    expect(wrapper).toContain('BASE_BROWSER_QA_FAIL_FAST')
    expect(wrapper).toContain('PILOT_BROWSER_QA_FAIL_FAST')
    expect(wrapper).toContain('OFFLINE_STOP_QA_FAIL_FAST')
    expect(wrapper).toContain('POST_PROMOTION_SANTA_FE_3D_QA_FAIL_FAST')
    expect(wrapper).toContain('POST_PROMOTION_3D_RETRY_LOOP_ISOLATION=PASS')
    expect(wrapper).toContain('POST_PROMOTION_3D_OUTSIDE_EXPENSIVE_QA_RETRY_LOOP=PASS')
    expect(wrapper.match(/\|\| return 1/g)?.length).toBeGreaterThanOrEqual(4)
  })

  test('generated controlled-pilot API QA defers only the redundant public 3d browser proof', async () => {
    const entrypoint = await Bun.file(apiEntrypointPath).text()
    const public3dQa = await Bun.file(public3dQaPath).text()
    const wrapper = await Bun.file(wrapperPath).text()
    expect(entrypoint).toContain("endsWith('/pilot-api-qa.ts')")
    expect(entrypoint).toContain("process.env.STRACKER_DEFER_PUBLIC_3D_QA = '1'")
    expect(public3dQa).toContain("process.env.STRACKER_DEFER_PUBLIC_3D_QA === '1'")
    expect(public3dQa).toContain('PUBLIC_3D_QA_DEFERRED_TO_POST_PROMOTION')
    expect(public3dQa).toContain('runStrictSantaFePublicBrowserQa(options)')
    expect(wrapper).toContain('bun scripts/release/santa-fe-post-promotion-browser-qa.ts')
    expect(wrapper).toContain('.gates.WEB_3D_DENSE_CITY == "PASS"')
  })

  test('keeps rollback armed until release evidence exists', async () => {
    const wrapper = await Bun.file(wrapperPath).text()
    expect(wrapper).toContain('ROLLBACK_DISARM_BEFORE_EVIDENCE')
    expect(wrapper).toContain('ROLLBACK_DISARM_AFTER_EVIDENCE')
    expect(wrapper).toContain('RELEASE_EVIDENCE_BEFORE_ROLLBACK_DISARM=PASS')
    expect(wrapper).toContain("source.rindex('rollback_required=0')")
  })

  test('materializes only a hash of the candidate version in public release evidence', async () => {
    const wrapper = await Bun.file(wrapperPath).text()
    expect(wrapper).toContain('RELEASE_EVIDENCE_RAW_VERSION_FIELD')
    expect(wrapper).toContain("'publicVersionIdHash': candidate_version_hash")
    expect(wrapper).toContain("api_gates.pop('PUBLIC_VERSION_ID', None)")
    expect(wrapper).toContain("api_gates['PUBLIC_VERSION_ID_HASH'] = candidate_version_hash")
    expect(wrapper).toContain('RAW_VERSION_ID_IN_RELEASE_EVIDENCE')
    expect(wrapper).toContain("'rawVersionIdRetained': False")
  })
})