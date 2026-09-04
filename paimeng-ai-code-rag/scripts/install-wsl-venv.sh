#!/usr/bin/env bash
# Create or update the WSL-only Python environment without changing Windows' default .venv location.
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "This script is for WSL/Linux only. Use the existing Windows Python environment instead." >&2
  exit 1
fi

cd "$(dirname "$0")/.."

runtime_root="../wsl-rt-env/python"
export UV_PROJECT_ENVIRONMENT="$(pwd)/$runtime_root/.venv"
export UV_CACHE_DIR="$(pwd)/$runtime_root/uv-cache"
export UV_PYTHON_INSTALL_DIR="$(pwd)/$runtime_root/python-install"

uv sync --locked "$@"

echo "WSL virtual environment ready at $UV_PROJECT_ENVIRONMENT"
