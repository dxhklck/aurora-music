import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue()],
    build: {
      // 移动端跑在 Android WebView 里（vivo V1831A 是 Chromium 66 老内核），
      // 默认 'modules' 基线（es2020）不转译 ??= / ?. 等语法，老内核直接
      // SyntaxError 白屏。压到 es2017 让 esbuild 全量降级；Vue3 需要的
      // Proxy 是运行时 API（Chrome 49+），不受语法目标影响。
      target: 'es2017',
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    }
  }
})
