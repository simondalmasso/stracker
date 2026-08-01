#!/usr/bin/env bash
set -euo pipefail

BUILD_EXPORT=1 bunx next build

test -f out/share.html
test -f out/shared.html
mkdir -p out/share out/shared
cp out/share.html out/share/index.html
cp out/shared.html out/shared/index.html

# These files are repository references or tooling artifacts, not runtime assets.
rm -f \
  out/gemini-analysis-input.json \
  out/s-tracker-extension.zip \
  out/mapa.html \
  out/mapa_v10.html

# Fail closed if an unexpected root-level file would become public.
while IFS= read -r path; do
  name="${path#out/}"
  case "$name" in
    index.html|404.html|_not-found.html|share.html|shared.html|manifest.json|robots.txt|logo.svg|_headers|_redirects|*.txt)
      ;;
    *)
      echo "UNEXPECTED_EXPORT_ROOT_FILE=$name"
      exit 1
      ;;
  esac
done < <(find out -maxdepth 1 -type f -print | LC_ALL=C sort)

if find out -type f \( \
  -name '.env*' -o \
  -name '*.zip' -o \
  -name '*.log' -o \
  -name '*.map' -o \
  -name '*.pem' -o \
  -name '*.key' \
\) -print -quit | grep -q .; then
  echo 'FORBIDDEN_EXPORT_ASSET_PRESENT'
  exit 1
fi

test ! -e out/.git
test ! -e out/.github

echo 'MOBILE_EXPORT_PUBLIC_ALLOWLIST=PASS'
