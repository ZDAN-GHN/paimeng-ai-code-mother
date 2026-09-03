// 服务入口：默认端口 8092
import { loadConfig } from './config.js'
import { buildApp } from './app.js'

const config = loadConfig()
const app = buildApp(config)

const stop = async (): Promise<void> => {
  await app.close()
  process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())

app.listen({ port: config.port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err)
  process.exit(1)
})
