#!/usr/bin/env bash
# Set up dimOS + dimos-ar for local development.
#
# Usage:
#   ./launcher/scripts/setup.sh              # interactive first-run setup
#   ./launcher/scripts/setup.sh --yes        # non-interactive; fail fast if dimOS cannot be auto-detected
#   ./launcher/scripts/setup.sh --check      # non-destructive readiness probe (for the web launcher)
#   ./launcher/scripts/setup.sh --yes --dimos-python <path>   # use existing dimOS interpreter
#   ./launcher/scripts/setup.sh --yes --clone-dir <path> [--dimos-ref <branch|tag|sha>]
#
# Environment (optional):
#   DIMOS_PYTHON  Path to Python in an existing dimOS environment
#   CI=1          Same as --yes

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIMOS_AR_ROOT="${ROOT}/dimos-ar"
source "$(dirname "${BASH_SOURCE[0]}")/dimos_lib.sh"

NON_INTERACTIVE=0
DO_CHECK=0
FLAG_DIMOS_PYTHON=""
FLAG_CLONE_DIR=""
FLAG_DIMOS_REF=""
FLAG_MANIPULATION=0

if [[ "${CI:-}" == "1" ]]; then
  NON_INTERACTIVE=1
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manipulation)
      FLAG_MANIPULATION=1
      shift
      ;;
    --yes|-y)
      NON_INTERACTIVE=1
      shift
      ;;
    --check)
      DO_CHECK=1
      shift
      ;;
    --dimos-ref)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "--dimos-ref requires a branch, tag, or SHA" >&2
        exit 1
      fi
      FLAG_DIMOS_REF="$2"
      shift 2
      ;;
    --dimos-python)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "--dimos-python requires a path argument" >&2
        exit 1
      fi
      FLAG_DIMOS_PYTHON="$2"
      shift 2
      ;;
    --clone-dir)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "--clone-dir requires a path argument" >&2
        exit 1
      fi
      FLAG_CLONE_DIR="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Try: $0 --help" >&2
      exit 1
      ;;
  esac
done

if [[ -n "${FLAG_DIMOS_PYTHON}" && -n "${FLAG_CLONE_DIR}" ]]; then
  echo "Use either --dimos-python or --clone-dir, not both." >&2
  exit 1
fi

absolute_setup_path() {
  local path="$1"
  if [[ "${path}" == "~/"* ]]; then
    path="${HOME}/${path:2}"
  fi
  if [[ "${path}" != /* ]]; then
    path="${PWD}/${path}"
  fi
  printf '%s\n' "${path}"
}

DEFAULT_DIMOS_DIR="$(cd "${ROOT}/.." && pwd)/dimos"

ask_yes_no() {
  local prompt="$1"
  local default="${2:-}"
  local reply=""

  while true; do
    if [[ -n "${default}" ]]; then
      read -r -p "${prompt} [${default}] " reply
      reply="${reply:-${default}}"
    else
      read -r -p "${prompt} " reply
    fi
    case "${reply}" in
      y|Y|yes|YES) return 0 ;;
      n|N|no|NO) return 1 ;;
      *) echo "Please answer y or n." ;;
    esac
  done
}

prompt_with_default() {
  local prompt="$1"
  local default="$2"
  local reply=""
  read -r -p "${prompt} [${default}] " reply
  printf '%s\n' "${reply:-${default}}"
}

python_is_312() {
  local py="$1"
  "${py}" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)
PY
}

find_python_for_venv() {
  local candidate=""
  for candidate in python3.12 python3; do
    if command -v "${candidate}" >/dev/null 2>&1 && python_is_312 "$(command -v "${candidate}")"; then
      command -v "${candidate}"
      return 0
    fi
  done
  return 1
}

run_check() {
  echo "Starting setup check…"
  local dimos_py=""
  local dimos_status="not found"
  local ar_status="not installed"
  local check_ok=0
  local dimos_version=""
  local dimos_ref=""

  if [[ -n "${FLAG_DIMOS_PYTHON}" ]]; then
    DIMOS_PYTHON="$(absolute_setup_path "${FLAG_DIMOS_PYTHON}")"
  fi

  if dimos_py="$(find_dimos_python "${ROOT}" 2>/dev/null)"; then
    dimos_status="installed (${dimos_py})"
    while IFS= read -r metadata; do
      case "${metadata}" in
        DIMOS_VERSION=*) dimos_version="${metadata#DIMOS_VERSION=}" ;;
        DIMOS_REF=*) dimos_ref="${metadata#DIMOS_REF=}" ;;
      esac
    done < <("${dimos_py}" "${ROOT}/launcher/app/dimos_installation.py" --metadata 2>/dev/null)
    if python_is_312 "${dimos_py}"; then
      ar_code="$(python_dimos_ar_status "${dimos_py}" || true)"
    else
      ar_code="unsupported_python"
    fi
    case "${ar_code}" in
      unsupported_python)
        ar_status="requires Python 3.12"
        ;;
      installed)
        ar_status="installed"
        check_ok=1
        ;;
      stale)
        ar_status="stale install (blueprints not registered)"
        ;;
      *)
        ar_status="not installed"
        ;;
    esac
  fi

  echo "dimOS: ${dimos_status}"
  if [[ -n "${dimos_version}" ]]; then
    echo "dimOS version: ${dimos_version}"
  fi
  if [[ -n "${dimos_ref}" ]]; then
    echo "dimOS ref: ${dimos_ref}"
  fi
  echo "dimos-ar: ${ar_status}"
  if openai_api_key_is_set "${ROOT}"; then
    print_color 1 32 "OPENAI_API_KEY = true"
  else
    print_color 1 31 "OPENAI_API_KEY = false"
  fi
  echo "CHECK_OK=${check_ok}"
  if [[ -n "${dimos_py}" ]]; then
    echo "DIMOS_PYTHON=${dimos_py}"
  fi
  if [[ -n "${dimos_version}" ]]; then
    echo "DIMOS_VERSION=${dimos_version}"
  fi
  if [[ -n "${dimos_ref}" ]]; then
    echo "DIMOS_REF=${dimos_ref}"
  fi

  if [[ "${check_ok}" -eq 1 ]]; then
    print_color 1 32 "Setup check successful"
    exit 0
  fi
  print_color 1 31 "Setup check failed"
  exit 1
}

if [[ "${DO_CHECK}" -eq 1 ]]; then
  run_check
fi

prompt_for_existing_dimos_python() {
  local candidate=""
  while true; do
    read -r -p "Enter the path to the Python executable in your dimOS environment: " candidate
    if [[ -z "${candidate}" ]]; then
      echo "A Python path is required." >&2
      continue
    fi
    candidate="$(absolute_setup_path "${candidate}")"
    if [[ ! -x "${candidate}" ]]; then
      echo "Not executable: ${candidate}" >&2
      continue
    fi
    if ! python_has_dimos "${candidate}"; then
      echo "That interpreter does not have the 'dimos' package installed." >&2
      continue
    fi
    printf '%s\n' "${candidate}"
    return 0
  done
}

ensure_dimos_clone() {
  local dimos_dir="$1"
  local bootstrap_python="$2"

  if "${bootstrap_python}" "${ROOT}/launcher/app/dimos_installation.py" "${dimos_dir}"; then
    echo "Reusing existing dimOS clone: ${dimos_dir}" >&2
    checkout_dimos_ref "${dimos_dir}"
    printf '%s\n' "${dimos_dir}"
    return 0
  fi

  if [[ -e "${dimos_dir}" ]]; then
    if [[ -d "${dimos_dir}" ]] && [[ -z "$(ls -A "${dimos_dir}")" ]]; then
      :
    else
      echo "Refusing to clone into non-empty path: ${dimos_dir}" >&2
      echo "Pass --clone-dir to an empty directory, or remove the existing path." >&2
      exit 1
    fi
  fi

  echo "Cloning dimOS into: ${dimos_dir}" >&2
  git clone "https://github.com/dimensionalOS/dimos" "${dimos_dir}" 1>&2
  checkout_dimos_ref "${dimos_dir}"
  printf '%s\n' "${dimos_dir}"
}

checkout_dimos_ref() {
  local dimos_dir="$1"
  local ref="${FLAG_DIMOS_REF:-}"
  [[ -n "${ref}" ]] || return 0
  echo "Checking out dimOS ref: ${ref}" >&2
  git -C "${dimos_dir}" fetch --tags origin 1>&2
  # The chooser lists remote branch names, which may have stale local branches.
  if git -C "${dimos_dir}" show-ref --verify --quiet "refs/remotes/origin/${ref}"; then
    ref="refs/remotes/origin/${ref}"
  fi
  local commit
  commit="$(git -C "${dimos_dir}" rev-parse --verify --end-of-options "${ref}^{commit}")"
  git -C "${dimos_dir}" checkout --detach "${commit}" 1>&2
}

install_dimos_from_clone() {
  local dimos_dir="$1"
  local bootstrap_python="$2"
  dimos_dir="$(absolute_setup_path "${dimos_dir}")"
  local dimos_python="${dimos_dir}/.venv/bin/python3"

  ensure_dimos_clone "${dimos_dir}" "${bootstrap_python}" >/dev/null
  if [[ ! -x "${dimos_python}" ]]; then
    "${bootstrap_python}" -m venv "${dimos_dir}/.venv"
  fi
  DIMOS_INSTALL_SOURCE="${dimos_dir}"
  DIMOS_ENV_PYTHON="${dimos_python}"
}

resolve_dimos_python() {
  local found=""
  local bootstrap_python=""
  local dimos_dir=""

  if [[ -n "${FLAG_DIMOS_PYTHON}" ]]; then
    FLAG_DIMOS_PYTHON="$(absolute_setup_path "${FLAG_DIMOS_PYTHON}")"
    if [[ ! -x "${FLAG_DIMOS_PYTHON}" ]]; then
      echo "Not executable: ${FLAG_DIMOS_PYTHON}" >&2
      exit 1
    fi
    if ! python_has_dimos "${FLAG_DIMOS_PYTHON}"; then
      echo "Warning: not a dimOS environment (no 'dimos' package): ${FLAG_DIMOS_PYTHON}" >&2
      echo "Select a dimOS environment or use --clone-dir." >&2
      exit 1
    fi
    DIMOS_ENV_PYTHON="${FLAG_DIMOS_PYTHON}"
    return 0
  fi

  if [[ -n "${FLAG_CLONE_DIR}" ]]; then
    if ! bootstrap_python="$(find_python_for_venv)"; then
      echo "Could not find Python 3.12 on PATH. Install Python 3.12 and re-run ./launcher/scripts/setup.sh." >&2
      exit 1
    fi
    FLAG_DIMOS_REF="${FLAG_DIMOS_REF:-$(cat "${ROOT}/.dimos-revision")}"
    install_dimos_from_clone "${FLAG_CLONE_DIR}" "${bootstrap_python}"
    return 0
  fi

  if [[ "${NON_INTERACTIVE}" -eq 1 ]]; then
    if found="$(find_dimos_python "${ROOT}")"; then
      DIMOS_ENV_PYTHON="${found}"
      return 0
    fi
    print_dimos_python_help "${ROOT}"
    exit 1
  fi

  if ask_yes_no "Is dimOS already installed on this Mac?" "n"; then
    if found="$(find_dimos_python "${ROOT}")"; then
      echo "Detected dimOS Python: ${found}" >&2
      if ask_yes_no "Use this interpreter?" "y"; then
        DIMOS_ENV_PYTHON="${found}"
        return 0
      fi
    else
      echo "Auto-detection did not find dimOS." >&2
    fi
    DIMOS_ENV_PYTHON="$(prompt_for_existing_dimos_python)"
    return 0
  fi

  if ! bootstrap_python="$(find_python_for_venv)"; then
    echo "Could not find Python 3.12 on PATH. Install Python 3.12 and re-run ./launcher/scripts/setup.sh." >&2
    exit 1
  fi

  dimos_dir="$(prompt_with_default "Where should dimOS be cloned?" "${DEFAULT_DIMOS_DIR}")"
  FLAG_DIMOS_REF="$(prompt_with_default "dimOS git ref (branch, tag, or SHA)?" "${FLAG_DIMOS_REF:-$(cat "${ROOT}/.dimos-revision")}")"
  install_dimos_from_clone "${dimos_dir}" "${bootstrap_python}"
}

echo "Resolving dimOS environment..."
if [[ -n "${FLAG_DIMOS_REF}" ]]; then
  echo "dimOS ref: ${FLAG_DIMOS_REF}"
fi
DIMOS_INSTALL_SOURCE=""
DIMOS_ENV_PYTHON=""
resolve_dimos_python

if ! python_is_312 "${DIMOS_ENV_PYTHON}"; then
  echo "dimOS AR requires Python 3.12. Select a Python 3.12 environment or a new clone directory." >&2
  exit 1
fi
echo "Using dimOS Python: ${DIMOS_ENV_PYTHON}"

echo "Installing dimos-ar into that environment..."
(
  cd "${DIMOS_AR_ROOT}"
  extras="dev"
  dimos_extras="base,unitree"
  if [[ "${FLAG_MANIPULATION}" -eq 1 ]]; then
    extras="dev,manipulation"
    dimos_extras="planning"
    if [[ -z "${DIMOS_INSTALL_SOURCE}" ]]; then
      DIMOS_INSTALL_SOURCE="$("${DIMOS_ENV_PYTHON}" "${ROOT}/launcher/app/planner_install.py" --source || true)"
    fi
    "${DIMOS_ENV_PYTHON}" "${ROOT}/launcher/app/planner_install.py" --clean-conflicts
  fi
  requirements=(-e ".[${extras}]")
  if [[ -n "${DIMOS_INSTALL_SOURCE}" ]]; then
    requirements+=(-e "${DIMOS_INSTALL_SOURCE}[${dimos_extras}]")
  fi
  python_pip_install "${DIMOS_ENV_PYTHON}" "${requirements[@]}"
  if [[ "${FLAG_MANIPULATION}" -eq 1 ]]; then
    "${DIMOS_ENV_PYTHON}" "${ROOT}/launcher/app/planner_check.py"
  fi
)

if ! python_has_dimos_ar "${DIMOS_ENV_PYTHON}"; then
  echo "dimOS at ${DIMOS_ENV_PYTHON} cannot run dimos-ar blueprints after install." >&2
  echo "Need import dimos.ar and dimos.blueprints entry points unitree-go2-ar / unitree-go2-ar-agentic." >&2
  exit 1
fi

echo "Running unit tests..."
(
  cd "${DIMOS_AR_ROOT}"
  "${DIMOS_ENV_PYTHON}" -m pytest
)

cat <<EOF

Setup complete.

Next steps:
  ./launcher/scripts/start.sh
  ./launcher/scripts/start-launcher.sh

If dimOS lives somewhere unusual, you can always override auto-detection with:
  DIMOS_PYTHON=/path/to/dimos/.venv/bin/python3 ./launcher/scripts/start.sh
EOF
