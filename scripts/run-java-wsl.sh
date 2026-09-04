#!/usr/bin/env bash
# WSL-only Java entrypoint. Windows IDE keeps its existing Maven run configuration.
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "This script is for WSL/Linux only. Use the existing Windows IDE configuration instead." >&2
  exit 1
fi

project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"

command="${1:-run}"
if [ "$#" -gt 0 ]; then
  shift
fi
maven_build_dir="$project_root/wsl-rt-env/java/target"

case "$command" in
  run)
    exec ./mvnw -Dmaven.build.directory="$maven_build_dir" spring-boot:run "$@"
    ;;
  test)
    exec ./mvnw -Dmaven.build.directory="$maven_build_dir" test "$@"
    ;;
  compile)
    exec ./mvnw -Dmaven.build.directory="$maven_build_dir" compile "$@"
    ;;
  *)
    echo "Usage: bash scripts/run-java-wsl.sh <run|test|compile> [Maven arguments]" >&2
    exit 1
    ;;
esac
