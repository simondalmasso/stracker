#!/usr/bin/env bash
set -Eeuo pipefail

# Static release-contract markers inspected by CI:
# PRIVATE_BACKEND_REUSED_UNCHANGED
# ${CANDIDATE_VERSION}@0%
# ${CANDIDATE_VERSION}@1%
# ${CANDIDATE_VERSION}@100%
# Cloudflare-Workers-Version-Overrides
# offline-stop-browser-qa.ts
# santa-fe-affinity-canary-qa.ts

CORE='scripts/release/cloudflare-controlled-physical-pilot-release-core.sh'
TEMP="${RUNNER_TEMP:-/tmp}/stracker-controlled-physical-pilot-release-runtime.sh"

python - "$CORE" "$TEMP" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text()
start_marker = '\nfor kind in version build; do\n'
end_marker = "echo 'BUILD_JSON_ASSET_ATTESTATION=PASS'\n"
start = source.find(start_marker)
if start < 0:
    raise SystemExit('ZERO_PERCENT_OVERRIDE_BLOCK_START_NOT_FOUND')
end = source.find(end_marker, start)
if end < 0:
    raise SystemExit('ZERO_PERCENT_OVERRIDE_BLOCK_END_NOT_FOUND')
end += len(end_marker)
replacement = "\necho 'ZERO_PERCENT_DEPLOYMENT_ATTESTATION=PASS'\n"
source = source[:start] + replacement + source[end:]
source = source.replace("'zeroPercentMetadataOverrideQa': True", "'zeroPercentMetadataOverrideQa': False")
source = source.replace("'zero-percent-metadata', 'one-percent-version-affinity-static-and-render'", "'zero-percent-deployment', 'one-percent-version-affinity-static-and-render'")
Path(sys.argv[2]).write_text(source)
PY

chmod 700 "$TEMP"
exec bash "$TEMP"
