#!/usr/bin/env bash
# Fixed Postgres 16 service for the product database and the pi-durable harness storage.
#
#   npm run durable:pg -- start   # compose up the `postgres` service, wait for readiness, ensure the databases
#   npm run durable:pg -- stop    # stop the service (keeps the data directory)
#   npm run durable:pg -- purge   # remove the container and the data directory
#   npm run durable:pg -- status
#   npm run durable:pg -- psql
#
# Same instance, two databases: `paimeng_app` (product business tables) and `paimeng_agent`
# (pi-durable storage). The test databases `paimeng_app_test` / `paimeng_agent_test` live beside them.
# The data directory is `runtime/durable-pg/pgdata` (gitignored); the port is 55432 to stay clear of
# the repo's own 3306/3307/5432 services. Credentials are throwaway and only used on this machine.
set -euo pipefail

NAME="zslm-pg-paimeng"
PORT="55432"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${repo}/runtime/durable-pg/pgdata"
export PGPASSWORD="spike"
# Docker Hub is unreachable from this host; the compose service reuses the image already present.
# The legacy MySQL service still guards MYSQL_PASSWORD/MYSQL_ROOT_PASSWORD with `:?`; compose
# interpolates the whole file even for a single service, so fill placeholders we never start.
export MYSQL_PASSWORD="${MYSQL_PASSWORD:-unused-by-postgres}"
export MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-unused-by-postgres}"

cd "${repo}"
compose=(docker compose)
[[ -f .env ]] && compose+=(--env-file .env)

ensure_databases() {
	# 建库本身是幂等的；只建缺失的库。
	for db in paimeng_app paimeng_app_test paimeng_agent paimeng_agent_test; do
		if ! docker exec "${NAME}" psql -U spike -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${db}'" | grep -q 1; then
			docker exec "${NAME}" psql -U spike -d postgres -c "CREATE DATABASE ${db}" >/dev/null
		fi
	done
}

case "${1:-}" in
start)
	"${compose[@]}" up -d --wait postgres
	for _ in $(seq 1 60); do
		if docker exec "${NAME}" pg_isready -U spike -d paimeng_agent >/dev/null 2>&1; then
			ensure_databases
			echo "postgres ready on 127.0.0.1:${PORT} (paimeng_app, paimeng_app_test, paimeng_agent, paimeng_agent_test)"
			exit 0
		fi
		sleep 0.5
	done
	echo "postgres did not become ready" >&2
	exit 1
	;;
stop)
	"${compose[@]}" stop postgres >/dev/null
	echo "stopped ${NAME}"
	;;
purge)
	"${compose[@]}" rm -sf postgres >/dev/null 2>&1 || true
	rm -rf "${DATA_DIR}"
	echo "purged ${NAME} and ${DATA_DIR}"
	;;
status)
	docker ps -a --filter "name=${NAME}" --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
	;;
psql)
	shift || true
	docker exec -it "${NAME}" psql -U spike -d paimeng_agent "$@"
	;;
*)
	echo "usage: $0 {start|stop|purge|status|psql}" >&2
	exit 2
	;;
esac
