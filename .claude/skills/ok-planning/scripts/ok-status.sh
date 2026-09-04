#!/usr/bin/env bash
# ok-status.sh — bash wrapper that prints a quick health summary.
#
# Runs `ok doctor && ok task list --status pending --json | jq '. | length'`.
# Falls back gracefully when `jq` is not installed.

set -euo pipefail

ROOT="${1:-$(pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$ROOT"

node --experimental-strip-types "$REPO_ROOT/bin/ok.ts" doctor

if command -v jq >/dev/null 2>&1; then
  open=$(node --experimental-strip-types "$REPO_ROOT/bin/ok.ts" task list --status pending --json | jq 'length')
  in_progress=$(node --experimental-strip-types "$REPO_ROOT/bin/ok.ts" task list --status in_progress --json | jq 'length')
  review=$(node --experimental-strip-types "$REPO_ROOT/bin/ok.ts" task list --status review --json | jq 'length')
  echo "open tasks: $open   in progress: $in_progress   in review: $review"
else
  echo "(install jq for full counts; `ok task list --status pending --json` returns the array)"
fi
