import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import { resolve } from 'path'
import manifest from './manifest.json' with { type: 'json' }

// 仅本地开发构建需要连本地后端;商店正式构建(默认 production mode)不带这条权限。
const DEV_HOST_PERMISSION = 'http://127.0.0.1:3001/*'

export default defineConfig(({ mode }) => {
  const buildManifest =
    mode === 'development'
      ? { ...manifest, host_permissions: [...manifest.host_permissions, DEV_HOST_PERMISSION] }
      : manifest

  return {
    resolve: {
      preserveSymlinks: true,
    },
    plugins: [crx({ manifest: buildManifest })],
    build: {
      rollupOptions: {
        input: {
          chat: resolve(import.meta.dirname, 'src/chat/chat.html'),
          'service-worker': resolve(import.meta.dirname, 'src/background/service-worker.ts'),
          'content-chatgpt': resolve(import.meta.dirname, 'src/content-scripts/chatgpt-content.ts'),
          'content-gemini': resolve(import.meta.dirname, 'src/content-scripts/gemini-content.ts'),
          'content-doubao': resolve(import.meta.dirname, 'src/content-scripts/doubao-content.ts'),
          'content-deepseek': resolve(import.meta.dirname, 'src/content-scripts/deepseek-content.ts'),
          'content-claude': resolve(import.meta.dirname, 'src/content-scripts/claude-content.ts'),
        },
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      exclude: ['tests/e2e/**', 'node_modules/**'],
    },
  }
})
