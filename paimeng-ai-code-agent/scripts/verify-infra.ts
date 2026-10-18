import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const database = new URL(process.env.DATABASE_URL ?? '');
assert.equal(database.protocol, 'postgres:');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '55432');
assert.match(database.pathname, /^\/paimeng_app(?:_test)?$/);
const connection = new pg.Client({ connectionString: database.href });
await connection.connect();
try {
  const name = await connection.query<{ name: string }>('SELECT current_database() AS name');
  assert.equal(name.rows[0].name, database.pathname.slice(1));
  const account = await connection.query<{ account: string }>('SELECT current_user AS account');
  assert.equal(account.rows[0].account, 'spike');
  await connection.query('CREATE TEMPORARY TABLE infra_probe(value VARCHAR(64))');
  await connection.query('INSERT INTO infra_probe(value) VALUES ($1)', ['local-development-ready']);
  const values = await connection.query<{ value: string }>('SELECT value FROM infra_probe');
  assert.equal(values.rows[0].value, 'local-development-ready');
  console.log('VERIFIED Postgres on 127.0.0.1:55432 with a temporary read/write table');
} finally { await connection.end(); }

const redis = new URL(process.env.REDIS_URL ?? '');
assert.equal(redis.protocol, 'redis:');
assert.equal(redis.hostname, '127.0.0.1');
assert.equal(redis.port, '6379');
assert.equal(redis.pathname, '/0');
if (redis.username || redis.password) throw new Error('The dedicated local Redis URL must not contain credentials');
function exchange(commands: string[][], expected: string) {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: 6379 });
    let reply = '';
    const payload = commands.map(command => `*${command.length}\r\n` + command.map(value => `$${Buffer.byteLength(value)}\r\n${value}\r\n`).join('')).join('');
    socket.setTimeout(5000, () => { socket.destroy(new Error('Local Redis response timed out')); });
    socket.once('connect', () => { socket.write(payload); });
    socket.once('error', reject);
    socket.on('data', chunk => {
      reply += chunk.toString();
      if (reply.length < expected.length && !(reply.startsWith('-') && reply.endsWith('\r\n'))) return;
      try { assert.equal(reply, expected, 'Local Redis reply must match the requested operation'); socket.end(); resolve(); }
      catch (error) { socket.destroy(); reject(error); }
    });
    socket.once('end', () => { if (reply.length < expected.length) reject(new Error('Local Redis returned an incomplete reply')); });
  });
}
await exchange([['PING']], '+PONG\r\n');
const key = 'ts:infra-probe:' + randomUUID();
const value = 'persistent-local-development';
await exchange([['SET', key, value, 'EX', '120']], '+OK\r\n');
try {
  if (process.argv.includes('--restart-redis')) {
    execFileSync('docker', ['compose', '--env-file', '.env', '-f', 'compose.yaml', 'restart', 'redis'], { stdio: 'inherit' });
    execFileSync('docker', ['compose', '--env-file', '.env', '-f', 'compose.yaml', 'up', '-d', '--wait', '--no-recreate', 'redis'], { stdio: 'inherit' });
  }
  await exchange([['GET', key]], `$${value.length}\r\n${value}\r\n`);
  console.log('VERIFIED Redis on 127.0.0.1:6379 without a password and with real read/write' + (process.argv.includes('--restart-redis') ? ' retained across container restart' : ''));
} finally { await exchange([['DEL', key]], ':1\r\n'); }
