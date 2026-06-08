import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import { resolve } from 'path'
import manifest from './manifest.json' assert { type: 'json' }

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/popup.html'),
        options: resolve(__dirname, 'src/options/options.html'),
        'service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
        'content-chatgpt': resolve(__dirname, 'src/content-scripts/chatgpt-content.ts'),
        'content-gemini': resolve(__dirname, 'src/content-scripts/gemini-content.ts'),
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
  },
})
