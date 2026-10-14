import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '3306');
assert.equal(url.pathname, '/paimeng_ai_code_mother_ts');
const path = new URL('../runtime/evidence/id-migration.json', import.meta.url);
const tables = ['user', 'app', 'chat_history', 'ts_session', 'ts_message', 'ts_generation', 'ts_generation_lease'];
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const connection = await mysql.createConnection({ uri: url.href, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, timezone: 'Z' });
try {
  const data: Record<string, { count: number; digest: string }> = {};
  for (const table of tables) {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(`SELECT * FROM ${table}`);
    const serialized = rows.map(row => JSON.stringify(row)).sort();
    data[table] = { count: rows.length, digest: digest(JSON.stringify(serialized)) };
  }
  const artifacts: Record<string, string | null> = {};
  for (const file of ['runtime/code_output/html_42/index.html']) {
    try { artifacts[file] = digest(await readFile(new URL('../' + file, import.meta.url))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; artifacts[file] = null; }
  }
  const snapshot = { data, artifacts };
  if (process.argv[2] === 'prepare') {
    await mkdir(new URL('./', path), { recursive: true });
    await writeFile(path, JSON.stringify(snapshot), { mode: 0o600 });
    console.log('PREPARED exact existing records and application 42 source digest without exposing credentials');
  } else if (process.argv[2] === 'verify') {
    assert.deepEqual(snapshot, JSON.parse(await readFile(path, 'utf8')), 'Snowflake migration must preserve every existing record and source file');
    const [columns] = await connection.query<mysql.RowDataPacket[]>("SELECT EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='id' AND TABLE_NAME IN ('user','app','chat_history')");
    assert.equal(columns.length, 3);
    assert.ok(columns.every(row => row.extra === ''), 'All business primary keys must stop auto-incrementing');
    console.log('VERIFIED all existing records, relationships, sessions, messages, tasks and application 42 source retained');
  } else throw new Error('Usage: npm run verify:id-migration -- prepare|verify');
} finally { await connection.end(); }
