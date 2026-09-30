import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const base = process.env.APP_BASE_PATH ?? '/'
if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) {
  throw new Error('APP_BASE_PATH must be an absolute path ending in /')
}

export default defineConfig({
  base,
  plugins: [vue()],
  root: 'src/web',
  build: {
    outDir: '../../dist/public',
    emptyOutDir: true,
  },
})
