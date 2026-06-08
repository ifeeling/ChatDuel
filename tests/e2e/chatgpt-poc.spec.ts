import { test, expect } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

declare global {
  interface Window {
    __getStreaming: () => boolean
  }
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

test('ChatGPT adapter can write and read on mock page', async ({ page }) => {
  const url = 'file://' + path.resolve(__dirname, 'chatgpt-mock.html')
  await page.goto(url)

  // Verify isLoggedIn returns true
  const loggedIn = await page.locator("[data-testid='user-menu-button']").count()
  expect(loggedIn).toBeGreaterThan(0)

  // Write text
  await page.fill('#prompt-textarea', 'hello chatgpt')

  // Click send
  await page.click("[data-testid='send-button']")

  // Wait for streaming to finish
  await page.waitForFunction(() => {
    return !window.__getStreaming() && document.querySelector("[data-testid='conversation-turn']:last-child .markdown")?.textContent
  }, { timeout: 3000 })

  // Verify last response contains our text
  const lastText = await page.locator("[data-testid='conversation-turn']:last-child .markdown").textContent()
  expect(lastText).toContain('Mock AI response to: hello chatgpt')
})
