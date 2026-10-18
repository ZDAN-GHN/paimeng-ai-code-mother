#!/usr/bin/env bash
# Runs one spike script under the *product's* tsx from the product root.
#
# M2b: the harness process loads the product's build implementation on demand
# (`buildPreview`). That module uses the `@/` path alias and imports `server-only`,
# so it resolves only when tsx runs with the product root as cwd and with the
# `react-server` condition. Runners that never build do not need this wrapper.
#
#   ./run.sh src/server.ts        # cwd is the product root, script path is absolute
#
# SPIKE_* env is derived from the machine's pi model config exactly as
# pi-durable-pg/run.sh does; override SPIKE_BASE_URL / SPIKE_API_KEY / SPIKE_MODEL
# or DURABLE_PG_URL in the caller's environment to point elsewhere.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
product="$(cd "${here}/../../paimeng-ai-code-agent" && pwd)"
MODELS_JSON="${HOME}/.pi/agent/models.json"

read_oc_go() {
	node -e "process.stdout.write(String(require(process.argv[1]).providers['oc-go'][process.argv[2]] ?? ''))" "$MODELS_JSON" "$1"
}

export SPIKE_BASE_URL="${SPIKE_BASE_URL:-$(read_oc_go baseUrl)}"
export SPIKE_API_KEY="${SPIKE_API_KEY:-$(read_oc_go apiKey)}"
export SPIKE_MODEL="${SPIKE_MODEL:-deepseek-v4.1-flash}"

# The script path is relative to this spike, not to the product root we cd into.
script="$1"
shift
if [[ "${script}" != /* ]]; then script="${here}/${script}"; fi

cd "${product}"
exec node --import tsx --conditions=react-server "${script}" "$@"
