// vitest 配置：依赖解析适配 wsl-rt-env 运行时环境布局（WSL）。
// 约定：node_modules 物理位于 ../wsl-rt-env/ts-agent/node_modules，服务目录内不放（也不用符号链接）。
// Vite 不认 NODE_PATH，因此用 resolve.alias 显式指向运行时环境的包目录；
// 若服务目录本地存在 node_modules（Windows/IDE 常规安装），则不干预、走默认解析。
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const agentRoot = path.dirname(fileURLToPath(import.meta.url))
const rtNodeModules = path.resolve(agentRoot, '../wsl-rt-env/ts-agent/node_modules')
const useRuntimeEnv = !existsSync(path.join(agentRoot, 'node_modules'))

export default {
  ...(useRuntimeEnv
    ? {
        resolve: {
          // 只需覆盖业务代码的顶层裸导入（fastify / jose / vitest / ai / xstate / @ai-sdk/provider）；
          // 这些包自身的传递依赖按 Node 规则从其真实位置向上查找，天然落在同一 node_modules 树内
          alias: [
            { find: /^fastify$/, replacement: path.join(rtNodeModules, 'fastify') },
            { find: /^jose$/, replacement: path.join(rtNodeModules, 'jose') },
            { find: /^vitest$/, replacement: path.join(rtNodeModules, 'vitest') },
            { find: /^ai$/, replacement: path.join(rtNodeModules, 'ai') },
            { find: /^xstate$/, replacement: path.join(rtNodeModules, 'xstate') },
            { find: /^@ai-sdk\/provider$/, replacement: path.join(rtNodeModules, '@ai-sdk', 'provider') },
          ],
        },
        // vite 默认把缓存写到 node_modules/.vite，会在服务目录催生 node_modules，改写入运行时环境
        cacheDir: path.join(rtNodeModules, '.vite'),
      }
    : {}),
  test: {
    environment: 'node',
  },
}
