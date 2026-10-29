import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.protocol, 'postgres:');
assert.equal(url.hostname, '127.0.0.1', 'Test setup only targets the dedicated local Postgres');
assert.match(url.pathname, /^\/paimeng_app(?:_test)?$/);
url.pathname = '/paimeng_app_test';
const admin = new pg.Client({ connectionString: new URL('/postgres', url).href });
await admin.connect();
try {
  for (const name of ['paimeng_app_test', 'paimeng_agent_test']) {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!existing.rowCount) await admin.query(`CREATE DATABASE ${name}`);
  }
} finally { await admin.end(); }
const result = execFileSync(process.execPath, ['--import', 'tsx', '--env-file=.env', 'scripts/db/migrate.ts'], {
  stdio: 'inherit', env: { ...process.env, DATABASE_URL: url.href },
});
assert.equal(result, null);
console.log('Dedicated test databases are ready; development and legacy databases are unchanged');
