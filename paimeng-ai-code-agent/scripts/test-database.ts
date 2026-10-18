import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.protocol, 'postgres:');
assert.equal(url.hostname, '127.0.0.1', 'Test setup only targets the dedicated local Postgres');
assert.equal(url.port, '55432');
assert.equal(url.username, 'spike');
assert.match(url.pathname, /^\/paimeng_ts(?:_test)?$/);
url.pathname = '/paimeng_ts_test';
// 建库要连到维护库；测试库与开发库同一个实例、不同 database。
const admin = new pg.Client({ connectionString: url.href.replace('/paimeng_ts_test', '/postgres') });
await admin.connect();
try {
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', ['paimeng_ts_test']);
  if (!existing.rowCount) await admin.query('CREATE DATABASE paimeng_ts_test');
} finally { await admin.end(); }
const result = execFileSync(process.execPath, ['--import', 'tsx', '--env-file=.env', 'scripts/migrate.ts'], {
  stdio: 'inherit', env: { ...process.env, DATABASE_URL: url.href },
});
assert.equal(result, null);
console.log('Dedicated test database is ready; development and legacy databases are unchanged');
