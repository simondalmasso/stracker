#!/usr/bin/env bash
set -Eeuo pipefail

BACKEND_WORKER='stracker-native-sharing-backend'
STATE_DIR="${RUNNER_TEMP:-/tmp}/stracker-controlled-physical-pilot-release"
WRANGLER=(bunx wrangler@4.111.0)
PREVIOUS_FILE="$STATE_DIR/backend-previous-version-id.txt"

if [[ ! -s "$PREVIOUS_FILE" ]]; then
  echo 'ORDER001_BACKEND_ROLLBACK=NOT_AVAILABLE'
  exit 1
fi
PREVIOUS_VERSION="$(cat "$PREVIOUS_FILE")"
if "${WRANGLER[@]}" versions deploy "${PREVIOUS_VERSION}@100%" --name "$BACKEND_WORKER" --message 'STRACKER ORDER-001 automatic backend rollback' -y >"$STATE_DIR/backend-rollback.log" 2>&1; then
  echo 'ORDER001_BACKEND_ROLLBACK=EXECUTED'
  exit 0
fi
sed -E -e 's/[0-9a-f]{8}-[0-9a-f-]{27,}/[ID_REDACTED]/gI' -e 's/[A-Za-z0-9_-]{43,}/[VALUE_REDACTED]/g' "$STATE_DIR/backend-rollback.log" | tail -40
exit 1
