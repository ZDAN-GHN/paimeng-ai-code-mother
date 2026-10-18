/**
 * Ensures the four databases of the local Postgres instance and reports readiness.
 *
 *   npm run durable:pg            # 建缺失的 database，再打印就绪状态
 *   npm run durable:pg -- status  # 只打印就绪状态
 *
 * The instance is the machine's own Postgres container (`zslm-postgres`, 127.0.0.1:5432);
 * this repository does not manage its lifecycle. Host, port and credentials come from
 * `DATABASE_URL`. Same instance, four databases: `paimeng_app` (product business tables) and
 * `paimeng_agent` (pi-durable storage), with `paimeng_app_test` / `paimeng_agent_test` beside them.
 */
import assert from 'node:assert/strict';
import pg from 'pg';

const databases = ['paimeng_app', 'paimeng_app_test', 'paimeng_agent', 'paimeng_agent_test'];

const action = process.argv[2] ?? 'start';
assert.ok(['start', 'status'].includes(action), '用法：npm run durable:pg [-- start|status]');

const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.protocol, 'postgres:');
assert.match(url.pathname, /^\/paimeng_app(?:_test)?$/, 'DATABASE_URL 必须指向独立的 paimeng_app 或 paimeng_app_test 数据库');
const host = url.hostname;
const port = url.port || '5432';

// 建库要连到维护库；四个库与产品库同一个实例。
const admin = new pg.Client({ connectionString: new URL('/postgres', url).href });
try {
  await admin.connect();
} catch (error) {
  throw new Error(`无法连接 ${host}:${port} 上的 Postgres（DATABASE_URL 指向的实例）。本机用它自己的容器 zslm-postgres；先把它启动再重试。原因：${(error as Error).message}`);
}
try {
  if (action === 'start') {
    for (const name of databases) {
      const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (!existing.rowCount) {
        await admin.query(`CREATE DATABASE ${name}`);
        console.log(`已创建 ${name}`);
      }
    }
  }
  const version = await admin.query<{ version: string }>("SELECT current_setting('server_version') AS version");
  const present = await admin.query<{ datname: string; size: string }>(
    "SELECT datname, pg_size_pretty(pg_database_size(datname)) AS size FROM pg_database WHERE datname = ANY($1) ORDER BY datname",
    [databases],
  );
  const missing = databases.filter(name => !present.rows.some(row => row.datname === name));
  if (missing.length) throw new Error(`${host}:${port} 上缺少 database：${missing.join('、')}（先执行 npm run durable:pg）`);
  console.log(`Postgres ${host}:${port} 就绪（server_version ${version.rows[0].version}）`);
  for (const row of present.rows) console.log(`  ${row.datname} ${row.size}`);
} finally {
  await admin.end();
}
