#!/usr/bin/env bash
set -euo pipefail

SOURCE_SHA="${SOURCE_SHA:?SOURCE_SHA required}"

rm -rf out
mkdir -p public/__stracker
cleanup() {
  rm -f public/__stracker/build.json
  rmdir public/__stracker 2>/dev/null || true
}
trap cleanup EXIT

python - "$SOURCE_SHA" <<'PY'
import json
import sys
from pathlib import Path
Path('public/__stracker/build.json').write_text(json.dumps({
    'sourceSha': sys.argv[1],
    'release': 'native-sharing-live-synthetic-v1',
}, sort_keys=True) + '\n')
PY

NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_STRACKER_SHARED_RUNTIME=enabled bun run build:export
cleanup
trap - EXIT

rm -f \
  out/gemini-analysis-input.json \
  out/s-tracker-extension.zip \
  out/mapa.html \
  out/mapa_v10.html

while IFS= read -r path; do
  name="${path#out/}"
  case "$name" in
    index.html|404.html|_not-found.html|share.html|shared.html|manifest.json|robots.txt|logo.svg|_headers|_redirects|*.txt)
      ;;
    *)
      echo "UNEXPECTED_NATIVE_SHARING_RELEASE_ROOT_FILE=$name"
      exit 1
      ;;
  esac
done < <(find out -maxdepth 1 -type f -print | LC_ALL=C sort)

for required in \
  out/index.html \
  out/share/index.html \
  out/shared/index.html \
  out/__stracker/build.json; do
  test -f "$required"
done

if find out -type f \( \
  -name '.env*' -o \
  -name '*.zip' -o \
  -name '*.log' -o \
  -name '*.map' -o \
  -name '*.pem' -o \
  -name '*.key' \
\) -print -quit | grep -q .; then
  echo 'FORBIDDEN_NATIVE_SHARING_RELEASE_ASSET_PRESENT'
  exit 1
fi

test ! -e out/.git
test ! -e out/.github

echo 'NATIVE_SHARING_RELEASE_ASSET_ALLOWLIST=PASS'
echo 'NATIVE_SHARING_UI_ENABLED=PASS'
