#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
api_dir="$root_dir/src/app/api"
stash_dir="$(mktemp -d)"

restore_api() {
  if [[ -d "$stash_dir/api" ]]; then
    rm -rf "$api_dir"
    mkdir -p "$(dirname "$api_dir")"
    mv "$stash_dir/api" "$api_dir"
  fi
  rm -rf "$stash_dir"
}
trap restore_api EXIT INT TERM

if [[ -d "$api_dir" ]]; then
  mv "$api_dir" "$stash_dir/api"
fi

cd "$root_dir"
bunx prisma generate
BUILD_EXPORT=1 bunx next build
