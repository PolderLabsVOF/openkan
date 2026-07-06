#!/usr/bin/env bash
set -euo pipefail

SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Auto-detect the OpenCode config directory ---------------------------
# Priority:
#   1. $OPENCODE_CONFIG_DIR if set
#   2. explicit first argument (positional for backwards compat)
#   3. ~/.config/opencode (Linux convention)
#   4. ~/.config/opencode/ (canonical name actually used by opencode)
#   5. platform default: ~/Library/Application Support/opencode on macOS,
#      %APPDATA%/opencode on Windows (best-effort; ignored on this shell)
#
# If nothing is found, default to ~/.config/opencode so the install
# still completes (it just may not be picked up by opencode until the
# user points env vars at it).
if [[ -n "${OPENCODE_CONFIG_DIR:-}" ]]; then
  DEFAULT_TARGET="${OPENCODE_CONFIG_DIR}"
elif [[ "${OSTYPE:-}" == darwin* ]]; then
  DEFAULT_TARGET="${HOME}/Library/Application Support/opencode"
else
  DEFAULT_TARGET="${HOME}/.config/opencode"
fi

TARGET_ROOT="${1:-${DEFAULT_TARGET}}"

if [[ "${TARGET_ROOT}" == "--help" || "${TARGET_ROOT}" == "-h" ]]; then
  cat <<USAGE >&2
Usage: $0 [opencode-config-dir]

Auto-detects the opencode config directory in this order:
  1. \$OPENCODE_CONFIG_DIR
  2. positional argument
  3. ~/.config/opencode (or platform equivalent)

Defaults to: ${DEFAULT_TARGET}
USAGE
  exit 0
fi

GLOBAL_PLUGIN_ROOT="${TARGET_ROOT}"

if [[ ! -d "${GLOBAL_PLUGIN_ROOT}" ]]; then
  echo "[openkan] target dir does not exist: ${GLOBAL_PLUGIN_ROOT}" >&2
  echo "[openkan] creating it now. If opencode has not been launched yet, this is OK." >&2
  mkdir -p "${GLOBAL_PLUGIN_ROOT}"
fi

mkdir -p "${GLOBAL_PLUGIN_ROOT}/kanban" "${GLOBAL_PLUGIN_ROOT}/plugins" "${GLOBAL_PLUGIN_ROOT}/web"

cp -R "${SRC_ROOT}/kanban/." "${GLOBAL_PLUGIN_ROOT}/kanban/"
cp "${SRC_ROOT}/plugins/kanban.ts" "${GLOBAL_PLUGIN_ROOT}/plugins/kanban.ts"
cp "${SRC_ROOT}/plugins/tools.ts" "${GLOBAL_PLUGIN_ROOT}/plugins/tools.ts"
cp -R "${SRC_ROOT}/web/." "${GLOBAL_PLUGIN_ROOT}/web/"
cp -R "${SRC_ROOT}/bin/." "${GLOBAL_PLUGIN_ROOT}/bin/"

if [[ ! -f "${GLOBAL_PLUGIN_ROOT}/package.json" ]]; then
  cp "${SRC_ROOT}/package.json" "${GLOBAL_PLUGIN_ROOT}/package.json"
  if [[ -f "${SRC_ROOT}/package-lock.json" ]]; then
    cp "${SRC_ROOT}/package-lock.json" "${GLOBAL_PLUGIN_ROOT}/package-lock.json"
  fi
else
  # Merge deps into the existing target package.json.
  # Pass paths via env vars so Node 24+ doesn't try to import
  # package.json as an ESM module (positional file args require
  # import attributes on modern Node).
  SOURCE_PKG="${SRC_ROOT}/package.json" \
  TARGET_PKG="${GLOBAL_PLUGIN_ROOT}/package.json" \
  node --input-type=commonjs -e '
    const fs = require("fs")
    const sourcePath = process.env.SOURCE_PKG
    const targetPath = process.env.TARGET_PKG
    const sourcePkg = JSON.parse(fs.readFileSync(sourcePath, "utf8"))
    const targetPkg = JSON.parse(fs.readFileSync(targetPath, "utf8"))

    targetPkg.dependencies = {
      ...(targetPkg.dependencies ?? {}),
      ...(sourcePkg.dependencies ?? {}),
    }

    if (sourcePkg.devDependencies && Object.keys(sourcePkg.devDependencies).length > 0) {
      targetPkg.devDependencies = {
        ...(targetPkg.devDependencies ?? {}),
        ...sourcePkg.devDependencies,
      }
    }

    if (!targetPkg.type && sourcePkg.type) targetPkg.type = sourcePkg.type
    if (targetPkg.private === undefined && sourcePkg.private !== undefined) {
      targetPkg.private = sourcePkg.private
    }

    fs.writeFileSync(targetPath, `${JSON.stringify(targetPkg, null, 2)}\n`, "utf8")
  '
fi

# --- Install the agent skill to ~/.config/opencode/skills/openkan/ ------------
SKILL_SRC="${SRC_ROOT}/skills/openkan"
SKILL_DST="${TARGET_ROOT}/skills/openkan"
if [[ -d "${SKILL_SRC}" ]]; then
  mkdir -p "${TARGET_ROOT}/skills"
  rm -rf "${SKILL_DST}"
  cp -R "${SKILL_SRC}" "${SKILL_DST}"
  echo "[openkan] Installed agent skill to ${SKILL_DST}"
fi

# --- Install the /organize slash command ----------------------------------------
COMMAND_SRC="${SRC_ROOT}/.opencode/command"
COMMAND_DST="${TARGET_ROOT}/command"
if [[ -d "${COMMAND_SRC}" ]]; then
  mkdir -p "${COMMAND_DST}"
  cp -R "${COMMAND_SRC}/." "${COMMAND_DST}/"
  echo "[openkan] Installed slash commands to ${COMMAND_DST}"
fi

# --- Symlink the CLI onto PATH ------------------------------------------------
BIN_PATH=""
for candidate in "${HOME}/.local/bin" "${HOME}/bin" "/usr/local/bin"; do
  if [[ -d "${candidate}" && -w "${candidate}" ]]; then
    BIN_PATH="${candidate}"
    break
  fi
done

SYMLINKED=false
if [[ -n "${BIN_PATH}" ]]; then
  ln -sf "${GLOBAL_PLUGIN_ROOT}/bin/openkan.mjs" "${BIN_PATH}/openkan"
  SYMLINKED=true
  echo "[openkan] Symlinked \`openkan\` → ${BIN_PATH}/openkan"
fi

echo ""
echo "Installed OpenKan globally into ${GLOBAL_PLUGIN_ROOT}"

if [[ -d "${SKILL_DST}" ]]; then
  echo "Installed openkan agent skill to ${SKILL_DST}"
  echo "  Agents can now learn openkan at skills/openkan/SKILL.md"
fi

if [[ -d "${TARGET_ROOT}/command" ]]; then
  echo "Installed slash commands to ${TARGET_ROOT}/command/"
  echo "  Use \`/organize\` in OpenCode to re-categorize and clean up the board."
fi

if [[ "${SYMLINKED}" == true ]]; then
  echo "Run \`openkan start\` to start the server (or open http://127.0.0.1:7777/)."
  echo "The dashboard has four tabs: Tasks, Changelog, Contributors, Docs."
else
  echo "Add ${GLOBAL_PLUGIN_ROOT}/bin to your PATH to use the \`openkan\` command."
fi
