#!/usr/bin/env bash
# WSL-only frontend entrypoint. Windows IDE keeps using its existing npm configuration.
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
  dev|preview|build|build-only|type-check|lint|format|openapi2ts)
    exec npm run "$command" -- "$@"
    ;;
  *)
    echo "Usage: bash scripts/run-wsl.sh <dev|preview|build|build-only|type-check|lint|format|openapi2ts> [arguments]" >&2
    exit 1
    ;;
esac
