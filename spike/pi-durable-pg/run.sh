#!/usr/bin/env bash
# Runs a Postgres-storage experiment with DURABLE_MODEL_* env derived from the machine's
# pi model config (oc-go provider). Values are exported into the child process
# only — never echoed, never written to disk.
#
#   ./run.sh experiments/01-basic.ts
#
# Override DURABLE_MODEL_BASE_URL / DURABLE_MODEL_API_KEY / DURABLE_MODEL_ID or DURABLE_PG_URL in the
# caller's environment to point somewhere else.
set -euo pipefail

MODELS_JSON="${HOME}/.pi/agent/models.json"

read_oc_go() {
	node -e "process.stdout.write(String(require(process.argv[1]).providers['oc-go'][process.argv[2]] ?? ''))" "$MODELS_JSON" "$1"
}

export DURABLE_MODEL_BASE_URL="${DURABLE_MODEL_BASE_URL:-$(read_oc_go baseUrl)}"
export DURABLE_MODEL_API_KEY="${DURABLE_MODEL_API_KEY:-$(read_oc_go apiKey)}"
export DURABLE_MODEL_ID="${DURABLE_MODEL_ID:-deepseek-v4.1-flash}"

exec node --experimental-strip-types "$@"
