#!/usr/bin/env bash
# WSL-only frontend dependency installer. npm writes directly to the ignored runtime project.
set -euo pipefail

if [ "$(uname -s)" != "Linux" ]; then
  echo "This script is for WSL/Linux only. Use npm install in the Windows service directory instead." >&2
  exit 1
fi

cd "$(dirname "$0")/.."

project_root="$PWD"
runtime_root="$project_root/../wsl-rt-env/frontend"

if [ -L node_modules ]; then
  echo "Refusing the legacy node_modules symlink; remove it before continuing." >&2
  exit 1
fi

mkdir -p "$runtime_root"
cp package.json package-lock.json "$runtime_root/"
npm --prefix "$runtime_root" install --cache "$runtime_root/npm-cache"

echo "WSL dependencies installed directly in $runtime_root/node_modules"
