#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/cloudflare-nonprod/lib/common.sh"
source "$SCRIPT_DIR/cloudflare-nonprod/lib/resolve.sh"
source "$SCRIPT_DIR/cloudflare-nonprod/lib/workers.sh"
source "$SCRIPT_DIR/cloudflare-nonprod/lib/access.sh"
source "$SCRIPT_DIR/cloudflare-nonprod/lib/validate.sh"
