#!/usr/bin/env sh
# Portable helper for Claude Code agents. Delegates to the canonical CLI.
set -eu
exec node --experimental-strip-types "${CLAUDE_PROJECT_DIR:-$(pwd)}/bin/openkan.ts" agent "$@"
