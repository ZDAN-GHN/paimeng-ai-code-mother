// 服务根目录解析（Issue #8 审查整改 B1）：config 与 prompts 加载器各自重复的 AGENT_ROOT 推断收敛到此。
// 优先取 AGENT_ROOT 环境变量（esbuild 打包产物物理位于 wsl-rt-env/ts-agent/dist，无法从 import.meta.url 反推，
// 由启动命令注入服务目录）；未注入时按源码位置推断（本文件位于 src/app/，上两级即服务根，测试直引源码时命中）。
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

export const agentRoot = process.env.AGENT_ROOT ? path.resolve(process.env.AGENT_ROOT) : path.resolve(moduleDir, '../..')
