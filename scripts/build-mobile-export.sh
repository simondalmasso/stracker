#!/usr/bin/env bash
set -euo pipefail

BUILD_EXPORT=1 bunx next build

test -f out/share.html
test -f out/shared.html
mkdir -p out/share out/shared
cp out/share.html out/share/index.html
cp out/shared.html out/shared/index.html
