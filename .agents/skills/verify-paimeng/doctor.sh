#!/usr/bin/env bash
# 只读体检：这次实例值不值得驱动。不启动、不修改任何东西。
set -uo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
app="$repo/paimeng-ai-code-agent"
cd "$app" || { echo "找不到应用目录: $app" >&2; exit 2; }
fail=0
ok()  { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; fail=1; }

major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${major:-0}" -ge 24 ]; then ok "node $(node -v)"; else bad "node 版本过低（需要 >= 24.15）：$(node -v 2>/dev/null || echo 未安装)"; fi

if [ -f .env ] && grep -qE '^DATABASE_URL=postgres://[^ ]*/paimeng_app' .env && grep -qE '^DURABLE_PG_URL=postgres://[^ ]*/paimeng_agent' .env; then
  ok ".env 的 DATABASE_URL / DURABLE_PG_URL 指向 paimeng_app / paimeng_agent"
else
  bad ".env 缺失或连接串不对（DATABASE_URL 需要 /paimeng_app，DURABLE_PG_URL 需要 /paimeng_agent）"
fi

for name in zslm-postgres zslm-redis; do
  running="$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo missing)"
  if [ "$running" = "true" ]; then ok "容器 $name 在跑"; else bad "容器 $name 不在跑（Postgres 需手动启动；Redis 用 npm run infra:up）"; fi
done

if [ -f .env ]; then
  node --input-type=module -e '
import { Client } from "pg";
import { loadEnvFile } from "node:process";
loadEnvFile(".env");
let bad = 0;
for (const name of ["paimeng_app", "paimeng_app_test", "paimeng_agent", "paimeng_agent_test"]) {
  const raw = name.startsWith("paimeng_agent") ? process.env.DURABLE_PG_URL : process.env.DATABASE_URL;
  if (!raw) { console.log(`  FAIL ${name}: 缺少连接串`); bad = 1; continue; }
  const url = new URL(raw);
  url.pathname = "/" + name;
  const client = new Client({ connectionString: url.href });
  try {
    await client.connect();
    await client.query("select 1");
    console.log(`  ok   ${name} 可连接`);
  } catch (error) {
    console.log(`  FAIL ${name}: ${error.message}`);
    bad = 1;
  } finally {
    await client.end().catch(() => {});
  }
}
process.exitCode = bad;
' || fail=1
else
  bad "跳过四个库的连接检查（没有 .env）"
fi

for port in "${E2E_APP_PORT:-3020}" "${E2E_PREVIEW_PORT:-3021}"; do
  if ss -ltn 2>/dev/null | grep -qE ":$port[[:space:]]"; then
    bad "端口 $port 已被占用（换 E2E_APP_PORT / E2E_PREVIEW_PORT，不要 pkill -f）"
  else
    ok "端口 $port 空闲"
  fi
done

if compgen -G "$HOME/.cache/ms-playwright/chromium*" > /dev/null; then
  ok "Playwright chromium 已安装"
else
  bad "缺少 chromium：npx playwright install chromium"
fi

if [ "$fail" -ne 0 ]; then
  echo "体检未通过：先修上面 FAIL 项，再跑证明。"
else
  echo "体检通过。"
fi
exit "$fail"
