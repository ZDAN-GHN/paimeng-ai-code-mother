import 'server-only';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { getConfig } from './config';
import * as schema from './schema';
const state=globalThis as typeof globalThis & {tsPool?:mysql.Pool};
export function getPool(){return state.tsPool??=mysql.createPool({uri:getConfig().databaseUrl,connectionLimit:8,supportBigNumbers:true,bigNumberStrings:true,dateStrings:true,timezone:'Z'});}
export function db(){return drizzle(getPool(),{schema,mode:'default'});}
export type Transaction = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];
export const now=()=>new Date().toISOString().slice(0,23).replace('T',' ');
