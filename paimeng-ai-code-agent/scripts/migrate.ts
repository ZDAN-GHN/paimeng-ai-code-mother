import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
const url=new URL(process.env.DATABASE_URL??'');
if(!/^paimeng_ai_code_mother_ts(?:_test)?$/.test(url.pathname.slice(1)))throw new Error('仅允许迁移独立 TS 数据库');
const connection=await mysql.createConnection({uri:url.href,multipleStatements:true});
try{
 await connection.query('CREATE TABLE IF NOT EXISTS ts_schema_migration(name VARCHAR(256) PRIMARY KEY, checksum VARCHAR(64) NOT NULL, appliedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
 const directory=new URL('../migrations/',import.meta.url);
 for(const name of (await readdir(directory)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort()){
  const sql=await readFile(new URL(name,directory),'utf8');const checksum=createHash('sha256').update(sql).digest('hex');
  const [rows]=await connection.execute<mysql.RowDataPacket[]>('SELECT checksum FROM ts_schema_migration WHERE name=?',[name]);
  if(rows.length){if(rows[0].checksum!==checksum)throw new Error(`已执行的迁移被修改 ${name}`);continue;}
  await connection.query(sql);await connection.execute('INSERT INTO ts_schema_migration(name,checksum) VALUES (?,?)',[name,checksum]);console.log(`已执行 ${name}`);
 }
 console.log('独立 TS 数据库迁移完成');
}finally{await connection.end();}
