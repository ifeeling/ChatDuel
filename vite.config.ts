import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import { resolve } from 'path'
import manifest from './manifest.json' with { type: 'json' }

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'src/popup/popup.html'),
        options: resolve(import.meta.dirname, 'src/options/options.html'),
        'service-worker': resolve(import.meta.dirname, 'src/background/service-worker.ts'),
        'content-chatgpt': resolve(import.meta.dirname, 'src/content-scripts/chatgpt-content.ts'),
        'content-gemini': resolve(import.meta.dirname, 'src/content-scripts/gemini-content.ts'),
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
  },
})
