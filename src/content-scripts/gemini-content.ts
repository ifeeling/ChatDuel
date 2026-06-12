import { createGeminiAdapter } from '../adapters/gemini/adapter'
import type { SwToContent, ContentToSw } from '../shared/messages'
import type { AIPlatform } from '../types'

const adapter = createGeminiAdapter()

adapter.onStreamEvent((event) => {
  const msg: ContentToSw = { type: 'stream-event', event }
  chrome.runtime.sendMessage(msg).catch(() => {/* SW may not be ready */})
})

if (window.parent !== window) {
  try {
    window.parent.postMessage(
      { source: 'aichatroom-content', event: 'ready', platform: 'gemini' },
      { targetOrigin: '*' },
    )
  } catch {
    /* ignore */
  }
}

window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as
    | { source?: string; action?: string; text?: string; imageDataUrl?: string; imageMime?: string; imageName?: string }
    | undefined
  if (!data || data.source !== 'aichatroom-parent') return
  if (data.action !== 'write-and-send') {
    // 父页发 get-state / get-last-response 查询(走 iframe 模式,SW 路径用不了——没有 tabId)
    if (data.action === 'get-state') {
      adapter.getConversationState().then((state) => {
        e.source?.postMessage(
          { source: 'aichatroom-content', type: 'state', platform: 'gemini', state },
          { targetOrigin: '*' },
        )
      })
      return
    }
    if (data.action === 'get-last-response') {
      adapter.getLastResponse().then((text) => {
        e.source?.postMessage(
          { source: 'aichatroom-content', type: 'last-response', platform: 'gemini', text },
          { targetOrigin: '*' },
        )
      })
      return
    }
    return
  }

  const text = data.text ?? ''
  const file = data.imageDataUrl
    ? dataUrlToFile(data.imageDataUrl, data.imageMime || 'image/png', data.imageName || 'image.png')
    : undefined

  void Promise.resolve()
    .then(() => adapter.sendMessage(text, file))
    .then(() => {
      e.source?.postMessage(
        { source: 'aichatroom-content', event: 'result', action: 'write-and-send', platform: 'gemini', ok: true },
        { targetOrigin: '*' },
      )
    })
    .catch((err: unknown) => {
      e.source?.postMessage(
        {
          source: 'aichatroom-content',
          event: 'result',
          action: 'write-and-send',
          platform: 'gemini',
          ok: false,
          error: String(err),
        },
        { targetOrigin: '*' },
      )
    })
})

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
        const reply: ContentToSw = { type: 'state', platform: 'gemini' as AIPlatform, state }
        sendResponse(reply)
      })
    return true
  }
  if (msg.type === 'get-last-response') {
    adapter
      .getLastResponse()
      .then((text) => {
        const reply: ContentToSw = { type: 'last-response', platform: 'gemini' as AIPlatform, text }
        sendResponse(reply)
      })
    return true
  }
  return false
})

// 把父页传过来的 dataURL 还原成 File(给 adapter.sendMessage 第二参数)
function dataUrlToFile(dataUrl: string, mime: string, name: string): File {
  const commaIdx = dataUrl.indexOf(',')
  const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl
  const bin = atob(b64)
  const len = bin.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: mime })
}
