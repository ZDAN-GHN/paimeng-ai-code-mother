import type { Pool, PoolConfig } from 'pg'
import pg from 'pg'

export function createSessionPool(config: PoolConfig = {}): Pool {
  return new pg.Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'paimeng',
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    ...config,
  })
}
