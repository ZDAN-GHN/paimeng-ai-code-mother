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
  enforce: 'pre' as const,
  resolveId(source: string) {
    if (source.startsWith('.') || source.startsWith('/') || source.startsWith('@/')) return null
    if (source === 'axios') return path.join(nodeModules, 'axios', 'index.js')
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
