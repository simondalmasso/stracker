import { describe, expect, test } from 'bun:test'

const wrapperPath = 'scripts/release/cloudflare-controlled-physical-pilot-release.sh'

describe('release evidence and rollback contract', () => {
  test('materialized post-promotion QA is fail-fast', async () => {
    const wrapper = await Bun.file(wrapperPath).text()
    expect(wrapper).toContain('API_QA_FAIL_FAST')
    expect(wrapper).toContain('BASE_BROWSER_QA_FAIL_FAST')
    expect(wrapper).toContain('PILOT_BROWSER_QA_FAIL_FAST')
    expect(wrapper).toContain('OFFLINE_STOP_QA_FAIL_FAST')
    expect(wrapper.match(/\|\| return 1/g)?.length).toBeGreaterThanOrEqual(4)
  })

  test('keeps rollback armed until release evidence exists', async () => {
    const wrapper = await Bun.file(wrapperPath).text()
    expect(wrapper).toContain('ROLLBACK_DISARM_BEFORE_EVIDENCE')
    expect(wrapper).toContain('ROLLBACK_DISARM_AFTER_EVIDENCE')
    expect(wrapper).toContain('RELEASE_EVIDENCE_BEFORE_ROLLBACK_DISARM=PASS')
    expect(wrapper).toContain("source.rindex('rollback_required=0')")
  })
})
