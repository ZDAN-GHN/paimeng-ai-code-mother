import { PrismaClient } from '@prisma/client'
import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.ts'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')
let url: URL
try {
  url = new URL(databaseUrl)
} catch {
  throw new Error('DATABASE_URL must be a valid MySQL URL')
}
if (url.protocol !== 'mysql:' || !url.hostname || !url.pathname.slice(1)) {
  throw new Error('DATABASE_URL must be a MySQL URL with a database')
}
const port = url.port ? Number(url.port) : 3306
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid database port')

const adapter = new PrismaMariaDb({
  host: url.hostname,
  port,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: decodeURIComponent(url.pathname.slice(1)),
  connectionLimit: 5,
  // MySQL 8 默认 caching_sha2_password，驱动拿不到服务端 RSA 公钥时直接建连失败并耗尽连接池。
  // 数据服务只挂在 Platform 内部网络且使用短生命周期凭据，这里允许拉取公钥（不走 mysql_native_password，避免退到已废弃的认证插件）
  allowPublicKeyRetrieval: true,
})
const prisma = new PrismaClient({ adapter })
const app = createApp({
  list: () => prisma.item.findMany({ orderBy: { id: 'desc' }, take: 100 }),
  create: (title) => prisma.item.create({ data: { title } }),
}, process.env.APP_BASE_PATH ?? '/', fileURLToPath(new URL('../public/', import.meta.url)))

app.addHook('onClose', async () => { await prisma.$disconnect() })
const portHttp = Number(process.env.PORT ?? '3000')
if (!Number.isInteger(portHttp) || portHttp < 1 || portHttp > 65535) throw new Error('Invalid PORT')

try {
  await app.listen({ port: portHttp, host: process.env.HOST ?? '127.0.0.1' })
} catch {
  console.error('Application failed to start')
  process.exitCode = 1
}
