// 应用装配：Fastify 实例 + 路由注册（生产入口与测试共用同一构建入口）
import Fastify, { type FastifyInstance } from 'fastify'
import { agentPlugin } from './authPlugin.js'
import { loadConfig, type ConfigOverrides } from './config.js'
import { registerHttpErrorHandler } from './httpError.js'
import { buildHealthzRoutes } from './healthzRoutes.js'
import type { AgentRouteOptions } from './agentRoutes.js'

export interface AppOverrides extends ConfigOverrides {
  agentRoutes?: AgentRouteOptions
}

export function buildApp(overrides: AppOverrides = {}): FastifyInstance {
  const config = loadConfig(process.env, overrides)
  const app = Fastify({
    logger: { level: config.logLevel },
  })
  buildHealthzRoutes(app)
  // 错误 JSON 单点产出（#21）：路由/预检 throw httpError(statusCode, message)，此处统一序列化
  registerHttpErrorHandler(app)
  // /agent/* 的鉴权与业务路由集中在插件作用域
  app.register(agentPlugin, { config, routeOptions: overrides.agentRoutes })
  return app
}
