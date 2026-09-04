#!/usr/bin/env node
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const frontendRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const runtimeRoot = path.resolve(frontendRoot, '..', 'wsl-rt-env', 'frontend')
const isWsl = process.platform === 'linux'
const nodeModules = isWsl ? path.join(runtimeRoot, 'node_modules') : path.join(frontendRoot, 'node_modules')

if (!existsSync(nodeModules)) {
  console.error(`[run] ${isWsl ? 'WSL' : 'Windows/IDE'} dependencies are missing: ${nodeModules}`)
  console.error(isWsl ? '[run] WSL: bash scripts/install-wsl-node-modules.sh' : '[run] Windows/IDE: npm install')
  process.exit(1)
}

const command = process.argv[2]
const args = process.argv.slice(3)
const runtimeEnv = isWsl
  ? {
      ...process.env,
      FRONTEND_NODE_MODULES: nodeModules,
      VITE_CACHE_DIR: path.join(runtimeRoot, 'vite-cache'),
      VITE_OUT_DIR: path.join(runtimeRoot, 'dist'),
      // eslint.config.ts 顶层裸导入（eslint/config 等）需经 NODE_PATH 命中实体依赖（服务目录无 node_modules）
      NODE_PATH: nodeModules,
    }
  : process.env

function run(commandPath, commandArgs) {
  const child = spawn(process.execPath, [commandPath, ...commandArgs], {
    cwd: frontendRoot,
    env: runtimeEnv,
    stdio: 'inherit',
  })
  child.on('exit', (code) => process.exit(code ?? 1))
}

function runSync(commandPath, commandArgs) {
  const result = spawnSync(process.execPath, [commandPath, ...commandArgs], {
    cwd: frontendRoot,
    env: runtimeEnv,
    stdio: 'inherit',
  })
  return result.status ?? 1
}

const vite = path.join(nodeModules, 'vite', 'bin', 'vite.js')
const vueTsc = path.join(nodeModules, 'vue-tsc', 'bin', 'vue-tsc.js')
const eslint = path.join(nodeModules, 'eslint', 'bin', 'eslint.js')
const prettier = path.join(nodeModules, 'prettier', 'bin', 'prettier.cjs')
const openapi = path.join(nodeModules, '@umijs', 'openapi', 'dist', 'cli.js')
const typeCheckConfig = isWsl ? 'tsconfig.wsl.json' : 'tsconfig.json'

switch (command) {
  case 'dev':
  case 'preview':
  case 'build-only':
    // 禁用 --configLoader runner：config 在临时 runner 中加载完 runner 即关闭，
    // vue/vue-devtools 插件运行期再经 runner 懒加载模块会崩（Vite module runner has been closed，
    // Windows 与 WSL 均复现）；默认 bundle 模式无此问题，且项目内 node_modules 可写，无 EROFS 顾虑
    run(vite, [command === 'build-only' ? 'build' : command, ...args])
    break
  case 'type-check':
    run(vueTsc, ['--build', typeCheckConfig, ...args])
    break
  case 'build':
    if (runSync(vueTsc, ['--build', typeCheckConfig]) !== 0) process.exit(1)
    run(vite, ['build', ...args])
    break
  case 'lint':
    run(eslint, ['.', '--fix', ...args])
    break
  case 'format':
    run(prettier, ['--write', 'src/', ...args])
    break
  case 'openapi2ts':
    run(openapi, ['--config', 'openapi2ts.config.ts', ...args])
    break
  default:
    console.error('[run] Usage: node scripts/run.mjs <dev|preview|build|build-only|type-check|lint|format|openapi2ts> [arguments]')
    process.exit(1)
}
