import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.protocol, 'mysql:');
assert.equal(url.hostname, '127.0.0.1', 'Test setup only targets the dedicated local MySQL');
assert.equal(url.port, '3306');
assert.equal(url.username, 'paimeng_ts');
assert.match(url.pathname, /^\/paimeng_ai_code_mother_ts(?:_test)?$/);
execFileSync('docker', ['compose', '--env-file', '.env', '-f', 'compose.yaml', 'exec', '-T', 'mysql', 'sh', '-c', 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -uroot'], {
  input: "CREATE DATABASE IF NOT EXISTS paimeng_ai_code_mother_ts_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL PRIVILEGES ON paimeng_ai_code_mother_ts_test.* TO 'paimeng_ts'@'%';",
  stdio: ['pipe', 'inherit', 'inherit'],
});
url.pathname = '/paimeng_ai_code_mother_ts_test';
const result = spawnSync(process.execPath, ['--import', 'tsx', '--env-file=.env', 'scripts/migrate.ts'], {
  stdio: 'inherit', env: { ...process.env, DATABASE_URL: url.href },
});
if (result.error) throw result.error;
assert.equal(result.status, 0, 'Dedicated test migrations must succeed');
console.log('Dedicated test database is ready; development and legacy databases are unchanged');
