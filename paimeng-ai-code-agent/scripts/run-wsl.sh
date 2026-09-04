#!/usr/bin/env bash
# WSL-only TS Agent entrypoint. Windows IDE keeps using its existing npm configuration.
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "This script is for WSL/Linux only. Use the existing Windows IDE configuration instead." >&2
  exit 1
fi

cd "$(dirname "$0")/.."
command="${1:-dev}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$command" in
  dev|start|build|test|type-check)
    exec npm run "$command" -- "$@"
    ;;
  *)
    echo "Usage: bash scripts/run-wsl.sh <dev|start|build|test|type-check> [arguments]" >&2
    exit 1
    ;;
esac
