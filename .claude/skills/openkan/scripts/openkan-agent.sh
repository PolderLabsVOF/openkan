#!/usr/bin/env sh
# Portable helper for Claude Code agents. Delegates to the canonical CLI.
set -eu
exec openkan agent "$@"
