#!/usr/bin/env bash
# Runs one harness/verification script under the *product's* tsx from the product root.
#
# The product harness imports product modules that use the `@/` path alias and
# `server-only`, so it resolves only when tsx runs with the product root as cwd
# and with the `react-server` condition.
#
#   ./run.sh ../../paimeng-ai-code-agent/src/server/durable/harness-server.ts
#
# DURABLE_MODEL_* env is derived from the machine's pi model config exactly as
# pi-durable-pg/run.sh does; override DURABLE_MODEL_BASE_URL / DURABLE_MODEL_API_KEY / DURABLE_MODEL_ID
# or DURABLE_PG_URL in the caller's environment to point elsewhere.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
product="$(cd "${here}/../../paimeng-ai-code-agent" && pwd)"
MODELS_JSON="${HOME}/.pi/agent/models.json"

read_oc_go() {
	node -e "process.stdout.write(String(require(process.argv[1]).providers['oc-go'][process.argv[2]] ?? ''))" "$MODELS_JSON" "$1"
}

export DURABLE_MODEL_BASE_URL="${DURABLE_MODEL_BASE_URL:-$(read_oc_go baseUrl)}"
export DURABLE_MODEL_API_KEY="${DURABLE_MODEL_API_KEY:-$(read_oc_go apiKey)}"
export DURABLE_MODEL_ID="${DURABLE_MODEL_ID:-deepseek-v4.1-flash}"

# The script path is relative to this spike, not to the product root we cd into.
script="$1"
shift
if [[ "${script}" != /* ]]; then script="${here}/${script}"; fi

cd "${product}"
exec node --import tsx --conditions=react-server "${script}" "$@"
