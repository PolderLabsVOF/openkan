#!/usr/bin/env bash
# ok-resume.sh — bash wrapper that prints an at-a-glance summary of what's
# open, in progress, and shippable.
#
# Reads .ok/index.json if it exists, else rebuilds it on the fly.
# Sorts each section by `updatedAt` descending.

set -euo pipefail

ROOT="${1:-$(pwd)}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$ROOT"

INDEX=".ok/index.json"
if [[ ! -f "$INDEX" ]]; then
  node --experimental-strip-types "$REPO_ROOT/bin/ok.ts" index >/dev/null
fi

if command -v jq >/dev/null 2>&1; then
  tasks_total=$(jq '.tasks | length' "$INDEX")
  plans_total=$(jq '.plans | length' "$INDEX")
  prds_total=$(jq '.prds | length' "$INDEX")
  tasks_open=$(jq '[.tasks[] | select(.status == "pending" or .status == "in_progress" or .status == "review")] | length' "$INDEX")
  plans_active=$(jq '[.plans[] | select(.status == "active")] | length' "$INDEX")
  prds_active=$(jq '[.prds[] | select(.status == "active")] | length' "$INDEX")

  echo "tasks: $tasks_open open / $tasks_total total"
  echo "plans: $plans_active active / $plans_total total"
  echo "prds:  $prds_active active / $prds_total total"
  echo "---"
  echo "most-recently-updated items:"
  jq -r '((.tasks + .plans + .prds) | sort_by(-.updatedAt) | .[0:5] | .[] | "  [\(.status)] \(.id)  \(.title)")' "$INDEX"
else
  echo "open tasks: $(node --experimental-strip-types "$REPO_ROOT/bin/ok.ts" task list --status pending --json | wc -l) bytes of JSON"
  echo "(install jq for the full breakdown)"
fi
