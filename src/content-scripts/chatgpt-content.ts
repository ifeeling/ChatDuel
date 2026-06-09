import { createChatGPTAdapter } from '../adapters/chatgpt/adapter'
import type { SwToContent, ContentToSw } from '../shared/messages'
import type { AIPlatform } from '../types'

const adapter = createChatGPTAdapter()

adapter.onStreamEvent((event) => {
  const msg: ContentToSw = { type: 'stream-event', event }
  chrome.runtime.sendMessage(msg).catch(() => {/* SW may not be ready */})
})

// 通知父页(iframe 父页)已就绪
if (window.parent !== window) {
  try {
    window.parent.postMessage(
      { source: 'aichatroom-content', event: 'ready', platform: 'chatgpt' },
      { targetOrigin: '*' },
    )
  } catch {
    /* ignore */
  }
}

// 接收父页通过 postMessage 直接发来的指令(iframe 模式)
window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as
    | { source?: string; action?: string; text?: string; imageDataUrl?: string }
    | undefined
  if (!data || data.source !== 'aichatroom-parent') return
  if (data.action !== 'write-and-send') return

  const text = data.text ?? ''

  void Promise.resolve()
    .then(() => adapter.sendMessage(text))
    .then(() => {
      e.source?.postMessage(
        { source: 'aichatroom-content', event: 'result', action: 'write-and-send', platform: 'chatgpt', ok: true },
        { targetOrigin: '*' },
      )
    })
    .catch((err: unknown) => {
      e.source?.postMessage(
        {
          source: 'aichatroom-content',
          event: 'result',
          action: 'write-and-send',
          platform: 'chatgpt',
          ok: false,
          error: String(err),
        },
        { targetOrigin: '*' },
      )
    })
})

// 接收 SW 通过 chrome.tabs.sendMessage 发来的指令(用户手动开 tab 模式)
chrome.runtime.onMessage.addListener((msg: SwToContent, _sender, sendResponse) => {
  if (msg.type === 'write-and-send') {
    adapter
      .sendMessage(msg.text)
      .then(() => sendResponse({ ok: true }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  if (msg.type === 'get-state') {
    adapter
      .getConversationState()
      .then((state) => {
        const reply: ContentToSw = { type: 'state', platform: 'chatgpt' as AIPlatform, state }
        sendResponse(reply)
      })
    return true
  }
  if (msg.type === 'get-last-response') {
    adapter
      .getLastResponse()
      .then((text) => {
        const reply: ContentToSw = { type: 'last-response', text }
        sendResponse(reply)
      })
    return true
  }
  return false
})
