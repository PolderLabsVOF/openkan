#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${OSTYPE:-}" == darwin* ]]; then
  DEFAULT_INSTALL_ROOT="${HOME}/Library/Application Support/OpenKan"
else
  DEFAULT_INSTALL_ROOT="${XDG_DATA_HOME:-${HOME}/.local/share}/openkan"
fi

INSTALL_ROOT="${OPENKAN_HOME:-${1:-${DEFAULT_INSTALL_ROOT}}}"
BIN_DIR="${OPENKAN_BIN_DIR:-${HOME}/.local/bin}"

if [[ "${INSTALL_ROOT}" == "--help" || "${INSTALL_ROOT}" == "-h" ]]; then
  cat <<USAGE
Usage: $0 [install-directory]

Installs or updates OpenKan in its own application directory.

Environment:
  OPENKAN_HOME              Override the application directory.
  OPENKAN_BIN_DIR           Override the command-link directory.
  OPENKAN_SKIP_DEPENDENCIES Skip dependency installation (tests/packaging only).

Defaults:
  application: ${DEFAULT_INSTALL_ROOT}
  command:     ${BIN_DIR}/openkan
USAGE
  exit 0
fi

if [[ -z "${INSTALL_ROOT}" || "${INSTALL_ROOT}" == "/" ]]; then
  echo "[openkan] refusing unsafe install directory: ${INSTALL_ROOT:-<empty>}" >&2
  exit 2
fi

INSTALL_PARENT="$(dirname "${INSTALL_ROOT}")"
INSTALL_NAME="$(basename "${INSTALL_ROOT}")"
mkdir -p "${INSTALL_PARENT}" "${BIN_DIR}"
INSTALL_PARENT="$(cd "${INSTALL_PARENT}" && pwd -P)"
INSTALL_ROOT="${INSTALL_PARENT}/${INSTALL_NAME}"

if [[ "${INSTALL_ROOT}" == "${SOURCE_ROOT}" ]]; then
  echo "[openkan] install directory must differ from the source checkout" >&2
  exit 2
fi

STAGING_ROOT="$(mktemp -d "${INSTALL_PARENT}/.openkan-install.XXXXXX")"
BACKUP_ROOT=""

cleanup() {
  rm -rf "${STAGING_ROOT}"
  if [[ -n "${BACKUP_ROOT}" && -e "${BACKUP_ROOT}" ]]; then
    rm -rf "${BACKUP_ROOT}"
  fi
}
trap cleanup EXIT

for directory in bin commands kanban skills web; do
  cp -R "${SOURCE_ROOT}/${directory}" "${STAGING_ROOT}/${directory}"
done

for file in package.json package-lock.json README.md CHANGELOG.md LICENSE; do
  if [[ -f "${SOURCE_ROOT}/${file}" ]]; then
    cp "${SOURCE_ROOT}/${file}" "${STAGING_ROOT}/${file}"
  fi
done

chmod +x "${STAGING_ROOT}/bin/openkan.mjs"

if [[ "${OPENKAN_SKIP_DEPENDENCIES:-0}" != "1" ]]; then
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "[openkan] Node.js and npm are required for installation" >&2
    exit 1
  fi
  (
    cd "${STAGING_ROOT}"
    npm install --omit=dev --ignore-scripts
  )
fi

if [[ -e "${INSTALL_ROOT}" ]]; then
  BACKUP_ROOT="${INSTALL_ROOT}.previous.$$"
  mv "${INSTALL_ROOT}" "${BACKUP_ROOT}"
fi

if ! mv "${STAGING_ROOT}" "${INSTALL_ROOT}"; then
  if [[ -n "${BACKUP_ROOT}" && -e "${BACKUP_ROOT}" ]]; then
    mv "${BACKUP_ROOT}" "${INSTALL_ROOT}"
    BACKUP_ROOT=""
  fi
  echo "[openkan] update failed; previous installation restored" >&2
  exit 1
fi
STAGING_ROOT=""

rm -rf "${BACKUP_ROOT}"
BACKUP_ROOT=""

ln -sfn "${INSTALL_ROOT}/bin/openkan.mjs" "${BIN_DIR}/openkan"

echo ""
echo "OpenKan installed successfully."
echo "  Application: ${INSTALL_ROOT}"
echo "  Command:     ${BIN_DIR}/openkan"
echo ""
echo "Run 'openkan init' inside a project, then 'openkan start'."
echo "Dashboard: http://127.0.0.1:7777/"
