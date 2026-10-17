#!/usr/bin/env bash
# Dependency resolution for M1. The harness reuses the pg spike's node_modules,
# but this package imports modules itself (playwright for verify-browser), so it
# needs its own node_modules directory. Real directory + symlinks, nothing here
# is committed (see .git/info/exclude).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
spike_modules="${here}/../pi-durable-pg/node_modules"
app_modules="${M1_APP_NODE_MODULES:-${here}/../../paimeng-ai-code-agent/node_modules}"

[ -d "${spike_modules}" ] || { echo "missing ${spike_modules}: run npm install in ../pi-durable-pg first" >&2; exit 1; }
[ -d "${app_modules}/playwright" ] || { echo "missing ${app_modules}/playwright: install the app's dependencies first" >&2; exit 1; }

mkdir -p "${here}/node_modules"
for name in @earendil-works @types typescript .bin; do
	ln -sfn "../../pi-durable-pg/node_modules/${name}" "${here}/node_modules/${name}"
done
ln -sfn "${app_modules}/playwright" "${here}/node_modules/playwright"
echo "linked ${here}/node_modules"
