#!/usr/bin/env bash
set -euo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
SOURCE_ROOT=""
if [[ -n "${SCRIPT_SOURCE}" && -f "${SCRIPT_SOURCE}" ]]; then
  SOURCE_ROOT="$(cd "$(dirname "${SCRIPT_SOURCE}")" && pwd -P)"
fi

if [[ "${OSTYPE:-}" == darwin* ]]; then
  DEFAULT_INSTALL_ROOT="${HOME}/Library/Application Support/OpenKan"
else
  DEFAULT_INSTALL_ROOT="${XDG_DATA_HOME:-${HOME}/.local/share}/openkan"
fi

INSTALL_ROOT="${OPENKAN_HOME:-${1:-${DEFAULT_INSTALL_ROOT}}}"
BIN_DIR="${OPENKAN_BIN_DIR:-${HOME}/.local/bin}"

if [[ "${INSTALL_ROOT}" == "--help" || "${INSTALL_ROOT}" == "-h" ]]; then
  cat <<USAGE
Usage: install.sh [install-directory]

Installs or updates OpenKan in its own application directory.

Environment:
  OPENKAN_HOME              Override the application directory.
  OPENKAN_BIN_DIR           Override the command-link directory.
  OPENKAN_INSTALL_REF       Source branch or tag name (default: main).
  OPENKAN_INSTALL_REF_KIND  Source ref kind: heads or tags (default: heads).
  OPENKAN_INSTALL_ARCHIVE_URL
                            Override the source archive URL.
  OPENKAN_SKIP_AGENT_SKILLS Skip installing agent workflow skills.
  OPENKAN_SKIP_DEPENDENCIES Skip dependency installation (tests/packaging only).

Defaults:
  application: ${DEFAULT_INSTALL_ROOT}
  command:     ${BIN_DIR}/openkan
USAGE
  exit 0
fi

has_complete_source() {
  [[ -n "${SOURCE_ROOT}" ]] &&
    [[ -d "${SOURCE_ROOT}/bin" ]] &&
    [[ -d "${SOURCE_ROOT}/commands" ]] &&
    [[ -d "${SOURCE_ROOT}/kanban" ]] &&
    [[ -d "${SOURCE_ROOT}/ok" ]] &&
    [[ -d "${SOURCE_ROOT}/skills" ]] &&
    [[ -d "${SOURCE_ROOT}/web" ]] &&
    [[ -f "${SOURCE_ROOT}/package.json" ]] &&
    [[ -f "${SOURCE_ROOT}/package-lock.json" ]]
}

if ! has_complete_source; then
  if [[ "${OPENKAN_BOOTSTRAPPED:-0}" == "1" ]]; then
    echo "[openkan] downloaded source archive is incomplete" >&2
    exit 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    echo "[openkan] tar is required for remote installation" >&2
    exit 1
  fi

  INSTALL_REF="${OPENKAN_INSTALL_REF:-main}"
  INSTALL_REF_KIND="${OPENKAN_INSTALL_REF_KIND:-heads}"
  case "${INSTALL_REF_KIND}" in
    heads|tags) ;;
    *)
      echo "[openkan] OPENKAN_INSTALL_REF_KIND must be heads or tags" >&2
      exit 2
      ;;
  esac
  ARCHIVE_URL="${OPENKAN_INSTALL_ARCHIVE_URL:-https://github.com/PolderLabsVOF/openkan/archive/refs/${INSTALL_REF_KIND}/${INSTALL_REF}.tar.gz}"
  BOOTSTRAP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openkan-bootstrap.XXXXXX")"
  BOOTSTRAP_ARCHIVE="${BOOTSTRAP_ROOT}/openkan.tar.gz"
  BOOTSTRAP_SOURCE="${BOOTSTRAP_ROOT}/source"

  cleanup_bootstrap() {
    if [[ -n "${BOOTSTRAP_ROOT:-}" && -e "${BOOTSTRAP_ROOT}" ]]; then
      rm -rf "${BOOTSTRAP_ROOT}"
    fi
  }
  trap cleanup_bootstrap EXIT

  echo "[openkan] Downloading OpenKan ${INSTALL_REF}..."
  if command -v curl >/dev/null 2>&1; then
    case "${ARCHIVE_URL}" in
      https://*)
        curl --proto '=https' --tlsv1.2 -fsSL "${ARCHIVE_URL}" -o "${BOOTSTRAP_ARCHIVE}"
        ;;
      *)
        curl -fsSL "${ARCHIVE_URL}" -o "${BOOTSTRAP_ARCHIVE}"
        ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "${BOOTSTRAP_ARCHIVE}" "${ARCHIVE_URL}"
  else
    echo "[openkan] curl or wget is required for remote installation" >&2
    exit 1
  fi

  mkdir -p "${BOOTSTRAP_SOURCE}"
  tar -xzf "${BOOTSTRAP_ARCHIVE}" -C "${BOOTSTRAP_SOURCE}" --strip-components=1
  if [[ ! -x "${BOOTSTRAP_SOURCE}/install.sh" ]]; then
    chmod +x "${BOOTSTRAP_SOURCE}/install.sh" 2>/dev/null || true
  fi
  OPENKAN_BOOTSTRAPPED=1 bash "${BOOTSTRAP_SOURCE}/install.sh" "$@"
  exit $?
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

STAGING_ROOT="$(mktemp -d "${INSTALL_PARENT}/.ok-install.XXXXXX")"
BACKUP_ROOT=""

cleanup() {
  if [[ -n "${STAGING_ROOT:-}" && -e "${STAGING_ROOT}" ]]; then
    rm -rf "${STAGING_ROOT}"
  fi
  if [[ -n "${BACKUP_ROOT}" && -e "${BACKUP_ROOT}" ]]; then
    rm -rf "${BACKUP_ROOT}"
  fi
}
trap cleanup EXIT

for directory in bin commands kanban ok skills web; do
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

install_agent_skill() {
  local skills_root="$1"
  local target="${skills_root}/openkan"
  local staged

  mkdir -p "${skills_root}"
  staged="$(mktemp -d "${skills_root}/.ok-skill.XXXXXX")"
  cp -R "${INSTALL_ROOT}/skills/openkan/." "${staged}/"
  rm -rf "${target}"
  mv "${staged}" "${target}"
}

if [[ "${OPENKAN_SKIP_AGENT_SKILLS:-0}" != "1" ]]; then
  install_agent_skill "${CODEX_HOME:-${HOME}/.codex}/skills"
  install_agent_skill "${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/skills"
  install_agent_skill "${AGENTS_HOME:-${HOME}/.agents}/skills"
fi

echo ""
echo "OpenKan installed successfully."
echo "  Application: ${INSTALL_ROOT}"
echo "  Command:     ${BIN_DIR}/openkan"
if [[ "${OPENKAN_SKIP_AGENT_SKILLS:-0}" != "1" ]]; then
  echo "  Agent skill: Codex, Claude Code, and shared agent skill directories"
fi
echo ""
echo "Run 'openkan init' inside a project, then 'openkan start'."
echo "Dashboard: http://127.0.0.1:7777/"
