#!/usr/bin/env bash
# Run the retired Python/RAG service from its WSL-only virtual environment.
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "This script is for WSL/Linux only. Use the existing Windows IDE configuration instead." >&2
  exit 1
fi

cd "$(dirname "$0")/.."

venv="$(pwd)/../wsl-rt-env/python/.venv"
python="$venv/bin/python"

if [ ! -x "$python" ]; then
  echo "WSL virtual environment is missing. Run: bash scripts/install-wsl-venv.sh" >&2
  exit 1
fi

case "${1:-serve}" in
  serve)
    shift || true
    exec "$python" -m uvicorn app.main:app --port 8091 "$@"
    ;;
  test)
    shift || true
    exec "$python" -m pytest "$@"
    ;;
  *)
    echo "Usage: bash scripts/run-wsl.sh <serve|test> [arguments]" >&2
    exit 1
    ;;
esac
