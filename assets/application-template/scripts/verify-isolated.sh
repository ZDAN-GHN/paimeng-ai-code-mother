#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(cd "$root/../.." && pwd)"
suffix="$$-$RANDOM"
network="issue79-template-$suffix"
db="issue79-db-$suffix"
app="issue79-app-$suffix"
base='/apps/42/'

cleanup() {
  docker rm -f "$app" "$db" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker image inspect mysql:8.0.46 >/dev/null
docker build --pull=false -t issue79-validation-runtime:local \
  -f "$repo/infra/docker/validation/Dockerfile" "$root" >/dev/null
docker build --pull=false --network none -t issue79-template-smoke:local \
  -f "$root/scripts/Dockerfile.smoke" "$root/scripts" >/dev/null
APP_BASE_PATH="$base" npm --prefix "$root" run build
password="$(openssl rand -hex 24)"
docker network create --internal --driver bridge "$network" >/dev/null
docker run -d --rm --name "$db" --network "$network" --memory 1g --cpus 1 --pids-limit 128 \
  --env "MYSQL_ROOT_PASSWORD=$password" --env MYSQL_DATABASE=issue79_template \
  mysql:8.0.46 >/dev/null

ready=0
for _ in $(seq 1 90); do
  if docker exec --env "MYSQL_PWD=$password" "$db" mysql -h127.0.0.1 --protocol=TCP \
      -uroot -Nse 'SELECT 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo 'Isolated database did not become ready' >&2
  docker logs --tail 15 "$db" >&2
  exit 1
fi

docker run -d --rm --name "$app" --network "$network" --read-only --cap-drop ALL \
  --security-opt no-new-privileges --memory 2g --cpus 2 --pids-limit 256 \
  --tmpfs /workspace:rw,exec,uid=1000,gid=1000,size=1073741824,mode=0700 \
  --tmpfs /tmp:rw,uid=1000,gid=1000,size=268435456,mode=0700 \
  issue79-template-smoke:local >/dev/null
docker exec "$app" mkdir -p /workspace/app
tar -C "$root" --exclude='./.env' --exclude='./.git' --exclude='./node_modules' \
  --exclude='./.npmrc' -cf - . | docker exec -i --workdir /workspace/app "$app" /bin/tar -xf -
docker exec "$app" cp -a /opt/validation/node_modules /workspace/app/node_modules

database_url="mysql://root:$password@$db:3306/issue79_template"
if docker exec --env "DATABASE_URL=$database_url" --workdir /workspace/app "$app" \
    npm run db:migrate:status >/dev/null 2>&1; then
  echo 'Expected pending migration before deploy' >&2
  exit 1
fi
docker exec --env "DATABASE_URL=$database_url" --workdir /workspace/app "$app" npm run db:migrate:deploy
docker exec --env "DATABASE_URL=$database_url" --workdir /workspace/app "$app" npm run db:migrate:status
docker exec --env "MYSQL_PWD=$password" "$db" mysql -uroot issue79_template -e \
  "INSERT INTO Item (title, createdAt) VALUES ('synthetic retained row', NOW(3));"
docker exec --env "DATABASE_URL=$database_url" --workdir /workspace/app "$app" npm run db:migrate:deploy
row="$(docker exec --env "MYSQL_PWD=$password" "$db" mysql -uroot issue79_template -Nse \
  'SELECT title FROM Item WHERE title = "synthetic retained row"')"
[[ "$row" == 'synthetic retained row' ]]

docker exec -d --env "DATABASE_URL=$database_url" --env "APP_BASE_PATH=$base" \
  --env HOST=127.0.0.1 --env PORT=3000 --workdir /workspace/app "$app" npm start
docker exec "$app" node --input-type=module -e '
  import assert from "node:assert/strict";
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const health = await fetch("http://127.0.0.1:3000/healthz");
      if (health.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(ready, "server did not become healthy");
  const base = "http://127.0.0.1:3000/apps/42/";
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /\/apps\/42\/assets\//);
  const list = await fetch(`${base}api/items`);
  assert.equal(list.status, 200);
  assert.ok((await list.json()).some(item => item.title === "synthetic retained row"));
  const created = await fetch(`${base}api/items`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "second synthetic row" })
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).title, "second synthetic row");
  console.log("Isolated MySQL migration and path-base HTTP smoke passed");
'
