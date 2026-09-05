import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
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

const runtimeDependencyResolver = {
  name: 'runtime-dependency-resolver',
  // 保持普通顺序：Vite 内置解析（依赖预构建的 ESM 互操作）优先，本插件仅在原生解析失败时
  // 兜底指向 wsl-rt-env 实体依赖。此前 enforce: 'pre' 直接返回文件路径会绕过预构建，
  // 浏览器原生加载 CJS 产物报 "does not provide an export named 'xxx'" 导致整页白屏
  resolveId(source: string) {
    if (source.startsWith('.') || source.startsWith('/') || source.startsWith('@/')) return null
    try {
      return packageRequire.resolve(source)
    } catch {
      return null
    }
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
