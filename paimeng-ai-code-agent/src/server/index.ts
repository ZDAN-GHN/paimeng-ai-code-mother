import { createServer, isWorkLoopEnabled, readPlatformBaseUrl } from './app.js'
import { PlatformWorkClient } from '../engine/platformWorkClient.js'
import { createPiNormalizationRunner, startAgentWorkLoop } from '../engine/agentWorkLoop.js'
import { createPlatformRunExecutor } from '../engine/platformRunExecutor.js'
import { PlatformClient } from '../engine/platformClient.js'
import { PiEngineAdapter } from '../pi/piEngineAdapter.js'

const port = Number.parseInt(process.env.AGENT_PORT ?? '8092', 10)
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('AGENT_PORT must be a valid TCP port')
}

const server = createServer()

try {
  await server.listen({ host: '127.0.0.1', port })
} catch (error: unknown) {
  await server.close()
  throw error
}

/**
 * 工作循环装配。
 *
 * `PlatformWorkClient` 与 `PlatformClient` 是两件事：前者取工作项与上报结果，
 * 后者才是受控执行的 Lease/Sandbox 通道。分成两个客户端，边界与 Java 侧的两组端点
 * 一致，也让测试能各自替换。
 */
if (isWorkLoopEnabled(process.env)) {
  const baseUrl = readPlatformBaseUrl(process.env)
  const provider = process.env.PI_AGENT_PROVIDER
  const modelId = process.env.PI_AGENT_MODEL_ID
  if (provider === undefined || provider.length === 0 || modelId === undefined || modelId.length === 0) {
    throw new Error('PI_AGENT_PROVIDER and PI_AGENT_MODEL_ID are required when the work loop is enabled')
  }
  const models = {
    provider,
    modelId,
    ...(process.env.PI_AGENT_MODELS_PATH === undefined
      ? {}
      : { modelsPath: process.env.PI_AGENT_MODELS_PATH }),
  }
  const platform = new PlatformClient({ baseUrl })
  startAgentWorkLoop({
    client: new PlatformWorkClient({ baseUrl }),
    normalize: createPiNormalizationRunner(models),
    executeRun: createPlatformRunExecutor({
      client: platform,
      engine: new PiEngineAdapter(models),
    }),
  })
}
