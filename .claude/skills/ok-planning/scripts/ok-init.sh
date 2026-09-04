#!/usr/bin/env bash
# ok-init.sh — bash wrapper that runs `ok init` and prints the layout.
#
# Usage: ok-init.sh [project-root]
#        (defaults to the current directory)

set -euo pipefail

ROOT="${1:-$(pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve the repo root (the directory that contains bin/ok.ts).
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

( cd "$ROOT" && node --experimental-strip-types "$REPO_ROOT/bin/ok.ts" init )
