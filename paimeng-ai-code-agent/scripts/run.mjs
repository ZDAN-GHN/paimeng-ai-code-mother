#!/usr/bin/env node
// 运行时环境调度器：统一解析 dev / build / start / test / type-check 的依赖与产物位置。
//
// 约定（与 AGENTS.md「运行时环境统一放 wsl-rt-env/，通过命令指定、不建软链」一致）：
//   - 当前进程为 Linux/WSL 时，固定使用 ../wsl-rt-env/ts-agent/node_modules
//   - Windows/IDE 时，固定使用服务目录 node_modules
// 两个平台绝不互相回退，避免加载错误平台的原生二进制。
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const agentRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const rtAgentRoot = path.resolve(agentRoot, '..', 'wsl-rt-env', 'ts-agent')
const isWsl = process.platform === 'linux'
const runtimeNodeModules = path.join(rtAgentRoot, 'node_modules')
const localNodeModules = path.join(agentRoot, 'node_modules')
const nodeModules = isWsl ? runtimeNodeModules : localNodeModules

if (!existsSync(nodeModules)) {
  console.error(`[run] ${isWsl ? 'WSL' : 'Windows/IDE'} dependencies are missing: ${nodeModules}`)
  console.error(isWsl ? '[run] WSL: bash scripts/install-wsl-node-modules.sh' : '[run] Windows/IDE: npm install')
  process.exit(1)
}

const node = process.execPath
const bundle = path.join(rtAgentRoot, 'dist', 'app.bundle.mjs')
// esbuild ESM 产物 banner：fastify 内部存在 CJS require 调用，注入 createRequire 使 bundle 自包含运行
const esbuildBanner = "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"

const [command, ...rest] = process.argv.slice(2)

function runChild(file, args, options = {}) {
  const child = spawn(file, args, { stdio: 'inherit', cwd: agentRoot, ...options })
  child.on('exit', (code) => process.exit(code ?? 1))
}

// 动态加载运行时环境里的 esbuild JS API（bin/esbuild 可能已被 postinstall 替换为原生二进制，不能假设是 JS）
// JS API 不读 NODE_PATH 环境变量（CLI 才读），用等价的 nodePaths 选项指定依赖查找目录
async function loadEsbuild() {
  const mod = await import(pathToFileURL(path.join(nodeModules, 'esbuild', 'lib', 'main.js')).href)
  return mod.default ?? mod
}

const esbuildOptions = {
  entryPoints: [path.join(agentRoot, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  sourcemap: true,
  outfile: bundle,
  banner: { js: esbuildBanner },
  nodePaths: [nodeModules],
  absWorkingDir: agentRoot,
  logLevel: 'info',
}

switch (command) {
  case 'build': {
    const esbuild = await loadEsbuild()
    await esbuild.build(esbuildOptions)
    console.log(`[run] 构建完成：${bundle}`)
    break
  }
  case 'start': {
    // AGENT_ROOT 告诉打包产物服务目录在哪（.env / 默认工作区相对路径的基准）
    runChild(node, ['--enable-source-maps', bundle], { env: { ...process.env, AGENT_ROOT: agentRoot } })
    break
  }
  case 'dev': {
    const esbuild = await loadEsbuild()
    // 重启链路由 esbuild watch 回调驱动：DrvFs（/mnt/c）上 node --watch 的文件事件不可靠，
    // 而 esbuild 自带轮询兜底可以稳定感知源码变更，每次成功重建后重启应用进程
    let app = null
    let exiting = false
    let restarting = false
    const spawnApp = () => {
      app = spawn(node, ['--enable-source-maps', bundle], {
        stdio: 'inherit',
        cwd: agentRoot,
        env: { ...process.env, AGENT_ROOT: agentRoot },
      })
      // 应用自身崩溃（如端口占用）时不立即拉起，等下次源码变更重建时再启动
      app.on('exit', () => {
        if (!exiting) app = null
      })
    }
    const restartApp = () => {
      if (restarting) return
      restarting = true
      if (!app) {
        spawnApp()
        restarting = false
        return
      }
      const old = app
      old.once('exit', () => {
        spawnApp()
        restarting = false
      })
      old.kill('SIGTERM')
    }
    const ctx = await esbuild.context({
      ...esbuildOptions,
      plugins: [
        {
          name: 'dev-restart',
          setup(builder) {
            builder.onEnd((result) => {
              // 构建失败时保留旧产物进程不动，成功才重启
              if (result.errors.length === 0) restartApp()
            })
          },
        },
      ],
    })
    // watch() 会先做一次完整构建（onEnd 回调里完成应用进程的首次拉起），随后进入变更监听
    await ctx.watch()
    const shutdown = () => {
      exiting = true
      app?.kill('SIGTERM')
      void ctx.dispose().finally(() => process.exit(0))
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    break
  }
  case 'test': {
    // vitest 依赖解析见 vitest.config.mjs（resolve.alias 指向运行时环境）
    runChild(node, [path.join(nodeModules, 'vitest', 'vitest.mjs'), 'run', ...rest])
    break
  }
  case 'type-check': {
    // tsc 依赖解析见 tsconfig.json（paths/typeRoots 双候选）
    runChild(node, [path.join(nodeModules, 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json', ...rest])
    break
  }
  default: {
    console.error('[run] 用法：node scripts/run.mjs <dev|build|start|test|type-check> [透传参数]')
    process.exit(1)
  }
}
