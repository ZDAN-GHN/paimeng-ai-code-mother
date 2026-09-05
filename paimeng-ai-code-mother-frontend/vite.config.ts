import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const frontendRoot = path.dirname(fileURLToPath(import.meta.url))
const nodeModules = process.env.FRONTEND_NODE_MODULES ?? path.join(frontendRoot, 'node_modules')

const packageRequire = createRequire(path.join(nodeModules, 'package.json'))

function runtimeModule(packagePath: string) {
  return pathToFileURL(path.join(nodeModules, packagePath)).href
}

const { defineConfig } = await import(runtimeModule('vite/dist/node/index.js'))
const { default: vue } = await import(runtimeModule('@vitejs/plugin-vue/dist/index.mjs'))
const { default: vueDevTools } = await import(runtimeModule('vite-plugin-vue-devtools/dist/vite.mjs'))

// 兜底解析只允许返回 ESM 入口：该路径不经依赖预构建，若返回 CJS main（vue/index.js、
// axios/dist/node/axios.cjs 等），浏览器原生加载会报 "does not provide an export named 'xxx'"
// 重演整页白屏；包无可用 ESM 入口时返回 null 放弃，让 Vite 显式报解析失败（明确报错优于静默白屏）
function resolveRuntimeModule(source: string): string | null {
  // 仅兜底裸包名导入；deep import（pkg/sub）的子路径语义复杂，兜底错入口会破坏模块身份，直接放弃
  const packageName = source.startsWith('@') ? source.split('/').slice(0, 2).join('/') : source.split('/')[0]
  if (packageName !== source) return null
  let resolved: string
  try {
    resolved = packageRequire.resolve(source)
  } catch {
    return null
  }
  let dir = path.dirname(resolved)
  while (dir !== path.dirname(dir)) {
    const pkgJsonPath = path.join(dir, 'package.json')
    if (existsSync(pkgJsonPath)) {
      const pkgJson = packageRequire(pkgJsonPath)
      const rootExport: unknown = pkgJson.exports?.['.']
      // import 条件可能是一层嵌套 conditions（如 vue 的 { node, default }），取 default 通用入口；
      // 无 import 时回退 module 字段；仅接受字段名保证 ESM 的两者，其余（axios/dayjs 等 CJS-only）放弃
      const importCondition: unknown =
        rootExport && typeof rootExport === 'object' ? (rootExport as Record<string, unknown>).import : undefined
      const esmEntry =
        (typeof importCondition === 'string'
          ? importCondition
          : importCondition && typeof importCondition === 'object'
            ? (importCondition as Record<string, unknown>).default
            : undefined) ?? pkgJson.module
      return typeof esmEntry === 'string' ? path.join(dir, esmEntry) : null
    }
    dir = path.dirname(dir)
  }
  return null
}

const runtimeDependencyResolver = {
  name: 'runtime-dependency-resolver',
  // 保持普通顺序：Vite 内置解析（依赖预构建的 ESM 互操作）优先，本插件仅在原生解析失败时
  // 兜底指向 wsl-rt-env 实体依赖；此前 enforce: 'pre' 直接返回文件路径绕过预构建导致整页白屏
  resolveId(source: string) {
    if (source.startsWith('.') || source.startsWith('/') || source.startsWith('@/')) return null
    return resolveRuntimeModule(source)
  },
}

// https://vite.dev/config/
export default defineConfig({
  esbuild: process.env.FRONTEND_NODE_MODULES
    ? {
        tsconfigRaw: {
          compilerOptions: {
            target: 'ESNext',
            useDefineForClassFields: true,
            module: 'ESNext',
            moduleResolution: 'Bundler',
            jsx: 'preserve',
          },
        },
      }
    : undefined,
  build: {
    outDir: process.env.VITE_OUT_DIR
  },
  cacheDir: process.env.VITE_CACHE_DIR,
  plugins: [runtimeDependencyResolver, vue(), vueDevTools()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8123',
        changeOrigin: true,
        secure: false
      },
      // Agent 生成流（SSE）：http-proxy 默认流式透传，不缓冲响应
      '/agent': {
        target: 'http://localhost:8092',
        changeOrigin: true,
        secure: false
      }
    }
  }
})
