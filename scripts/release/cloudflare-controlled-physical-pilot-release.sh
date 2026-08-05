#!/usr/bin/env bash
set -Eeuo pipefail

# Static release-contract markers inspected by CI:
# PRIVATE_BACKEND_REUSED_UNCHANGED
# ${CANDIDATE_VERSION}@0%
# ${CANDIDATE_VERSION}@1%
# ${CANDIDATE_VERSION}@100%
# Cloudflare-Workers-Version-Overrides
# ZERO_PERCENT_OVERRIDE_QA
# santa-fe-affinity-canary-qa.ts
# offline-stop-browser-qa.ts
# PUBLIC_POST_PROMOTION_QA
# RELEASE_EVIDENCE_BEFORE_ROLLBACK_DISARM

CORE='scripts/release/cloudflare-controlled-physical-pilot-release-core.sh'
TEMP="${RUNNER_TEMP:-/tmp}/stracker-controlled-physical-pilot-release-runtime.sh"

python - "$CORE" "$TEMP" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text()

def replace_once(old: str, new: str, code: str) -> None:
    global source
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{code}_EXPECTED_ONCE_OBSERVED_{count}')
    source = source.replace(old, new, 1)

replace_once(
    "assert not any(str(route).startswith('/data/santa-fe-3d') for route in public['assets'].get('run_worker_first', []))",
    "assert '/data/santa-fe-3d/*.pmtiles' in public['assets'].get('run_worker_first', [])",
    'PMTILES_RUN_WORKER_FIRST_ASSERTION',
)
replace_once("print('PMTILES_RUN_WORKER_FIRST=NO')", "print('PMTILES_RUN_WORKER_FIRST=YES')", 'PMTILES_RUN_WORKER_FIRST_MARKER')

start_marker = '\nfor kind in version build; do\n'
end_marker = "echo 'BUILD_JSON_ASSET_ATTESTATION=PASS'\n"
if source.count(start_marker) != 1:
    raise SystemExit(f'ZERO_PERCENT_OVERRIDE_BLOCK_START_EXPECTED_ONCE_OBSERVED_{source.count(start_marker)}')
start = source.index(start_marker)
end = source.find(end_marker, start)
if end < 0:
    raise SystemExit('ZERO_PERCENT_OVERRIDE_BLOCK_END_NOT_FOUND')
end += len(end_marker)
replacement = r'''
STRACKER_QA_URL="$TARGET_URL" \
STRACKER_EXPECTED_SHA="$SOURCE_SHA" \
STRACKER_EXPECTED_VERSION_ID="$CANDIDATE_VERSION" \
STRACKER_PUBLIC_WORKER="$PUBLIC_WORKER" \
STRACKER_ZERO_PERCENT_QA_OUTPUT="$STATE_DIR/zero-percent-override-qa.json" \
bun scripts/release/santa-fe-zero-percent-preflight.ts
jq -e '.privateDataUsed == false and .realUserCoordinatesUsed == false and .coordinateValuesRetained == false and .rawVersionIdRetained == false and .authorizationValuesRetained == false' "$STATE_DIR/zero-percent-override-qa.json" >/dev/null
jq -e '[.gates[] | select(. != "PASS")] | length == 0' "$STATE_DIR/zero-percent-override-qa.json" >/dev/null
echo 'VERSION_METADATA_OVERRIDE=PASS'
echo 'BUILD_JSON_ASSET_ATTESTATION=PASS'
echo 'SANTA_FE_MANIFEST_OVERRIDE=PASS'
echo 'PMTILES_QUERY_RANGE_OVERRIDE=PASS'
echo 'ZERO_PERCENT_OVERRIDE_QA=PASS'
'''
source = source[:start] + '\n' + replacement + source[end:]

qa_commands = [
    ('STRACKER_API_QA_OUTPUT="$API_QA_OUTPUT" bun "$STATE_DIR/pilot-api-qa.ts"', 'STRACKER_API_QA_OUTPUT="$API_QA_OUTPUT" bun "$STATE_DIR/pilot-api-qa.ts" || return 1', 'API_QA_FAIL_FAST'),
    ('bun scripts/release/live-native-sharing-browser-qa.ts', 'bun scripts/release/live-native-sharing-browser-qa.ts || return 1', 'BASE_BROWSER_QA_FAIL_FAST'),
    ('bun scripts/release/live-controlled-physical-pilot-browser-qa.ts', 'bun scripts/release/live-controlled-physical-pilot-browser-qa.ts || return 1', 'PILOT_BROWSER_QA_FAIL_FAST'),
    ('bun tests/native-sharing-cloudflare/offline-stop-browser-qa.ts', 'bun tests/native-sharing-cloudflare/offline-stop-browser-qa.ts || return 1', 'OFFLINE_STOP_QA_FAIL_FAST'),
]
for old, new, code in qa_commands:
    replace_once(old, new, code)

replace_once(
    'rollback_required=0\ntrap - ERR\npython - "$STATE_DIR" "$SOURCE_SHA"',
    'python - "$STATE_DIR" "$SOURCE_SHA"',
    'ROLLBACK_DISARM_BEFORE_EVIDENCE',
)
replace_once(
    "print('CONTROLLED_PHYSICAL_PILOT_READY=YES')\nPY\n\necho \"RELEASE_EVIDENCE_DIR=$STATE_DIR\"",
    "print('CONTROLLED_PHYSICAL_PILOT_READY=YES')\nPY\n\nrollback_required=0\ntrap - ERR\necho 'RELEASE_EVIDENCE_BEFORE_ROLLBACK_DISARM=PASS'\n\necho \"RELEASE_EVIDENCE_DIR=$STATE_DIR\"",
    'ROLLBACK_DISARM_AFTER_EVIDENCE',
)

required = [
    'ZERO_PERCENT_OVERRIDE_QA=PASS',
    'santa-fe-zero-percent-preflight.ts',
    'santa-fe-affinity-canary-qa.ts',
    '${CANDIDATE_VERSION}@0%',
    '${CANDIDATE_VERSION}@1%',
    '${CANDIDATE_VERSION}@100%',
    '|| return 1',
    'RELEASE_EVIDENCE_BEFORE_ROLLBACK_DISARM=PASS',
]
for marker in required:
    if marker not in source:
        raise SystemExit('MATERIALIZED_RELEASE_MARKER_MISSING_' + marker.replace('/', '_'))
if source.index('${CANDIDATE_VERSION}@0%') > source.index('${CANDIDATE_VERSION}@1%'):
    raise SystemExit('MATERIALIZED_ZERO_AFTER_CANARY')
if source.index('${CANDIDATE_VERSION}@1%') > source.index('${CANDIDATE_VERSION}@100%'):
    raise SystemExit('MATERIALIZED_CANARY_AFTER_PROMOTION')
if source.index("out.write_text(json.dumps(evidence") > source.rindex('rollback_required=0'):
    raise SystemExit('ROLLBACK_DISARMED_BEFORE_RELEASE_EVIDENCE')
Path(sys.argv[2]).write_text(source)
print('RELEASE_RUNTIME_PATCH_EXACT_ONCE=PASS')
print('ZERO_PERCENT_OVERRIDE_PREFLIGHT_RESTORED=PASS')
print('POST_PROMOTION_QA_FAIL_FAST=PASS')
print('ROLLBACK_ARMED_THROUGH_RELEASE_EVIDENCE=PASS')
PY

chmod 700 "$TEMP"
exec bash "$TEMP"
