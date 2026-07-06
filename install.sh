#!/usr/bin/env bash
set -euo pipefail

SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_TARGET="${OPENCODE_CONFIG_DIR:-${HOME}/.config/opencode}"
TARGET_ROOT="${1:-${DEFAULT_TARGET}}"

if [[ "${TARGET_ROOT}" == "--help" || "${TARGET_ROOT}" == "-h" ]]; then
  echo "Usage: $0 [opencode-config-dir]" >&2
  echo "Defaults to: ${DEFAULT_TARGET}" >&2
  exit 0
fi

GLOBAL_PLUGIN_ROOT="${TARGET_ROOT}"

mkdir -p "${GLOBAL_PLUGIN_ROOT}/kanban" "${GLOBAL_PLUGIN_ROOT}/plugins" "${GLOBAL_PLUGIN_ROOT}/web"

cp -R "${SRC_ROOT}/kanban/." "${GLOBAL_PLUGIN_ROOT}/kanban/"
cp "${SRC_ROOT}/plugins/kanban.ts" "${GLOBAL_PLUGIN_ROOT}/plugins/kanban.ts"
cp "${SRC_ROOT}/plugins/tools.ts" "${GLOBAL_PLUGIN_ROOT}/plugins/tools.ts"
cp -R "${SRC_ROOT}/web/." "${GLOBAL_PLUGIN_ROOT}/web/"

if [[ ! -f "${GLOBAL_PLUGIN_ROOT}/package.json" ]]; then
  cp "${SRC_ROOT}/package.json" "${GLOBAL_PLUGIN_ROOT}/package.json"
  if [[ -f "${SRC_ROOT}/package-lock.json" ]]; then
    cp "${SRC_ROOT}/package-lock.json" "${GLOBAL_PLUGIN_ROOT}/package-lock.json"
  fi
else
  node <<'EOF' "${SRC_ROOT}/package.json" "${GLOBAL_PLUGIN_ROOT}/package.json"
const fs = require("fs")

const [sourcePath, targetPath] = process.argv.slice(1)
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
EOF
fi

echo "Installed OpenKan globally into ${GLOBAL_PLUGIN_ROOT}"
echo "Restart OpenCode, then open http://127.0.0.1:7777/"
