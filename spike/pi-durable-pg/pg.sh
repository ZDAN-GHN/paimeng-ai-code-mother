#!/usr/bin/env bash
# Disposable Postgres for the pi-durable Postgres-storage spike.
#
#   ./pg.sh start   # create + start, wait until ready
#   ./pg.sh stop    # stop (keeps the data volume)
#   ./pg.sh purge   # remove container and data volume
#   ./pg.sh status
#   ./pg.sh psql
#
# The data directory lives under this project (pgdata/), the port is 55432 to
# stay clear of the repo's own 3306/3307/5432 services. Credentials are throwaway
# and only used inside this spike.
set -euo pipefail

NAME="zslm-pg-durable-spike"
# Docker Hub is unreachable from this host; reuse the Postgres 16 image already present.
IMAGE="pgvector/pgvector:pg16"
PORT="55432"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${here}/pgdata"
export PGPASSWORD="spike"

case "${1:-}" in
start)
	if docker ps -a --format '{{.Names}}' | grep -qx "${NAME}"; then
		docker start "${NAME}" >/dev/null
	else
		mkdir -p "${DATA_DIR}"
		docker run -d --name "${NAME}" \
			-e POSTGRES_USER=spike -e POSTGRES_PASSWORD=spike -e POSTGRES_DB=durable \
			-p "127.0.0.1:${PORT}:5432" \
			-v "${DATA_DIR}:/var/lib/postgresql/data" \
			"${IMAGE}" >/dev/null
	fi
	for _ in $(seq 1 60); do
		if docker exec "${NAME}" pg_isready -U spike -d durable >/dev/null 2>&1; then
			echo "postgres ready on 127.0.0.1:${PORT}"
			exit 0
		fi
		sleep 0.5
	done
	echo "postgres did not become ready" >&2
	exit 1
	;;
stop)
	docker stop "${NAME}" >/dev/null 2>&1 || true
	echo "stopped ${NAME}"
	;;
purge)
	docker rm -f "${NAME}" >/dev/null 2>&1 || true
	rm -rf "${DATA_DIR}"
	echo "purged ${NAME} and ${DATA_DIR}"
	;;
status)
	docker ps -a --filter "name=${NAME}" --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
	;;
psql)
	shift || true
	docker exec -it "${NAME}" psql -U spike -d durable "$@"
	;;
*)
	echo "usage: $0 {start|stop|purge|status|psql}" >&2
	exit 2
	;;
esac
