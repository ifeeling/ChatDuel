import { createGeminiAdapter } from '../adapters/gemini/adapter'
import type { SwToContent, ContentToSw } from '../shared/messages'
import type { AIPlatform } from '../types'

const adapter = createGeminiAdapter()

adapter.onStreamEvent((event) => {
  const msg: ContentToSw = { type: 'stream-event', event }
  chrome.runtime.sendMessage(msg).catch(() => {/* popup may be closed */})
})

chrome.runtime.onMessage.addListener((msg: SwToContent, _sender, sendResponse) => {
  if (msg.type === 'write-and-send') {
    adapter.sendMessage(msg.text)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  if (msg.type === 'get-state') {
    adapter.getConversationState()
      .then((state) => {
        const reply: ContentToSw = { type: 'state', platform: 'gemini' as AIPlatform, state }
        sendResponse(reply)
      })
    return true
  }
  if (msg.type === 'get-last-response') {
    adapter.getLastResponse()
      .then((text) => {
        const reply: ContentToSw = { type: 'last-response', text }
        sendResponse(reply)
      })
    return true
  }
  return false
})
