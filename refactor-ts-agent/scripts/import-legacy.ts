import { resolve, relative, isAbsolute } from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { users, apps, histories } from '../src/server/schema';
import { reserveImportedSnowflakeIds } from '../src/server/snowflake';
import { legacySnapshotSchema } from '../src/server/legacy-import';
const url=new URL(process.env.DATABASE_URL??'');if(!/^paimeng_ai_code_mother_ts(?:_test)?$/.test(url.pathname.slice(1)))throw new Error('导入仅支持独立 TS 库');
const input=process.argv[2];if(!input)throw new Error('用法 npm run db:import -- runtime/import/snapshot.json');
const root=await realpath(resolve('runtime/import'));const file=await realpath(resolve(input));const rel=relative(root,file);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('导入文件必须位于 runtime/import');if((await stat(file)).size>64*1024*1024)throw new Error('导入文件超过 64 MiB');
const snapshot=legacySnapshotSchema.parse(JSON.parse(await readFile(file,'utf8')));
const connection=await mysql.createConnection(url.href);const database=drizzle(connection);
try{await database.transaction(async tx=>{for(const row of snapshot.users)await tx.insert(users).values({...row,id:BigInt(row.id)});for(const row of snapshot.apps)await tx.insert(apps).values({...row,id:BigInt(row.id),userId:BigInt(row.userId)});for(const row of snapshot.chatHistory)await tx.insert(histories).values({...row,id:BigInt(row.id),userId:BigInt(row.userId),appId:BigInt(row.appId)});await reserveImportedSnowflakeIds(tx,[...snapshot.users,...snapshot.apps,...snapshot.chatHistory].map(row=>BigInt(row.id)));});console.log(`副本导入完成，用户 ${snapshot.users.length}，应用 ${snapshot.apps.length}，历史 ${snapshot.chatHistory.length}`);}finally{await connection.end();}
