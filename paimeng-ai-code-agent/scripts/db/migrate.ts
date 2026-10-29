import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
const url=new URL(process.env.DATABASE_URL??'');
if(!/^paimeng_app(?:_test)?$/.test(url.pathname.slice(1)))throw new Error('仅允许迁移独立的 paimeng_app 库');
const client=new pg.Client({connectionString:url.href});
await client.connect();
try{
 await client.query("CREATE TABLE IF NOT EXISTS schema_migration(name VARCHAR(256) PRIMARY KEY, checksum VARCHAR(64) NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT timezone('UTC', now()))");
 const directory=new URL('../../migrations/',import.meta.url);
 for(const name of (await readdir(directory)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort()){
  const sql=await readFile(new URL(name,directory),'utf8');const checksum=createHash('sha256').update(sql).digest('hex');
  const existing=await client.query<{checksum:string}>('SELECT checksum FROM schema_migration WHERE name=$1',[name]);
  const row=existing.rows[0];
  if(row){if(row.checksum!==checksum)throw new Error(`已执行的迁移被修改 ${name}`);continue;}
  await client.query('BEGIN');
  try{
   await client.query(sql);
   await client.query('INSERT INTO schema_migration(name,checksum) VALUES ($1,$2)',[name,checksum]);
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}
  console.log(`已执行 ${name}`);
 }
 console.log('产品 Postgres 库迁移完成');
}finally{await client.end();}
