import { test, expect } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

test('E2E: ChatGPT mock + Gemini mock can be driven in sequence', async ({ browser }) => {
  const chatgptPage = await browser.newPage()
  const geminiPage = await browser.newPage()

  await chatgptPage.goto('file://' + path.resolve(__dirname, 'chatgpt-mock.html'))
  await geminiPage.goto('file://' + path.resolve(__dirname, 'gemini-mock.html'))

  await chatgptPage.fill('#prompt-textarea', 'test question')
  await chatgptPage.click("[data-testid='send-button']")
  await chatgptPage.waitForFunction(() => {
    return !window.__getStreaming?.() && document.querySelector("[data-testid='conversation-turn']:last-child .markdown")?.textContent
  }, { timeout: 3000 })
  const chatgptResponse = await chatgptPage.locator("[data-testid='conversation-turn']:last-child .markdown").textContent()
  expect(chatgptResponse).toContain('Mock AI response to: test question')

  await geminiPage.locator('.ql-editor').fill('test question')
  await geminiPage.click("button[aria-label='Send message']")
  await geminiPage.waitForFunction(() => {
    return !window.__getStreaming?.() && document.querySelector('message-content:last-of-type model-response')?.textContent
  }, { timeout: 3000 })
  const geminiResponse = await geminiPage.locator('message-content:last-of-type model-response').textContent()
  expect(geminiResponse).toContain('Mock Gemini response to: test question')

  expect(chatgptResponse).toBeTruthy()
  expect(geminiResponse).toBeTruthy()
})
