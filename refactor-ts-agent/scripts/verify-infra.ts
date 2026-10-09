import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import mysql from 'mysql2/promise';

const database = new URL(process.env.DATABASE_URL ?? '');
assert.equal(database.protocol, 'mysql:');
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '3306');
assert.match(database.pathname, /^\/paimeng_ai_code_mother_ts(?:_test)?$/);
for (const key of database.searchParams.keys()) assert.equal(key, 'charset');
const connection = await mysql.createConnection(database.href);
try {
  const [rows] = await connection.query<mysql.RowDataPacket[]>('SELECT DATABASE() AS name');
  assert.equal(rows[0].name, database.pathname.slice(1));
  await connection.query('CREATE TEMPORARY TABLE ts_infra_probe(value VARCHAR(64))');
  await connection.execute('INSERT INTO ts_infra_probe(value) VALUES (?)', ['local-development-ready']);
  const [values] = await connection.query<mysql.RowDataPacket[]>('SELECT value FROM ts_infra_probe');
  assert.equal(values[0].value, 'local-development-ready');
  console.log('VERIFIED MySQL on 127.0.0.1:3306 with a temporary read/write table');
} finally { await connection.end(); }
const rootConnection = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: process.env.MYSQL_ROOT_PASSWORD, database: database.pathname.slice(1) });
try {
  const [rows] = await rootConnection.query<mysql.RowDataPacket[]>('SELECT CURRENT_USER() AS account');
  assert.equal(rows[0].account, 'root@%');
  console.log('VERIFIED MySQL root login through the local host port');
} finally { await rootConnection.end(); }

const redis = new URL(process.env.REDIS_URL ?? '');
assert.equal(redis.protocol, 'redis:');
assert.equal(redis.hostname, '127.0.0.1');
assert.equal(redis.port, '6381');
assert.equal(redis.pathname, '/0');
if (redis.username || redis.password) throw new Error('The dedicated local Redis URL must not contain credentials');
function exchange(commands: string[][], expected: string) {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: 6381 });
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
  console.log('VERIFIED Redis on 127.0.0.1:6381 without a password and with real read/write' + (process.argv.includes('--restart-redis') ? ' retained across container restart' : ''));
} finally { await exchange([['DEL', key]], ':1\r\n'); }
