import { test, expect } from '@playwright/test'
import { fileURLToPath } from 'url'
import path from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

declare global {
  interface Window {
    __getStreaming: () => boolean
  }
}

test('Gemini adapter can write and read on mock page', async ({ page }) => {
  const url = 'file://' + path.resolve(__dirname, 'gemini-mock.html')
  await page.goto(url)

  // Verify isLoggedIn: there is no loggedIn selector mock in the HTML; this is a noop for the mock
  // Write text
  await page.locator('.ql-editor').fill('hello gemini')

  // Click send
  await page.click("button[aria-label='Send message']")

  // Wait for streaming to finish
  await page.waitForFunction(() => {
    return !window.__getStreaming?.() && document.querySelector('message-content:last-of-type model-response')?.textContent
  }, { timeout: 3000 })

  // Verify last response contains our text
  const lastText = await page.locator('message-content:last-of-type model-response').textContent()
  expect(lastText).toContain('Mock Gemini response to: hello gemini')
})
