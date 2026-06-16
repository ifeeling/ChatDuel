import { createChatGPTAdapter } from '../adapters/chatgpt/adapter'
import type { SwToContent, ContentToSw } from '../shared/messages'
import type { AIPlatform } from '../types'
import { loadSelectorOverrides } from './selector-overrides'

async function boot() {
  const adapter = createChatGPTAdapter(await loadSelectorOverrides('chatgpt'))

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
      | { source?: string; action?: string; text?: string; imageDataUrl?: string; imageMime?: string; imageName?: string }
      | undefined
    if (!data || data.source !== 'aichatroom-parent') return
    if (data.action !== 'write-and-send') {
      // 父页发 get-state / get-last-response 查询(走 iframe 模式,SW 路径用不了——没有 tabId)
      if (data.action === 'get-state') {
        adapter.getConversationState().then((state) => {
          e.source?.postMessage(
            { source: 'aichatroom-content', type: 'state', platform: 'chatgpt', state },
            { targetOrigin: '*' },
          )
        })
        return
      }
      if (data.action === 'get-last-response') {
        adapter.getLastResponse().then((text) => {
          e.source?.postMessage(
            { source: 'aichatroom-content', type: 'last-response', platform: 'chatgpt', text },
            { targetOrigin: '*' },
          )
        })
        return
      }
      if (data.action === 'get-location') {
        e.source?.postMessage(
          { source: 'aichatroom-content', type: 'location', platform: 'chatgpt', href: location.href },
          { targetOrigin: '*' },
        )
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
          const reply: ContentToSw = { type: 'last-response', platform: 'chatgpt' as AIPlatform, text }
          sendResponse(reply)
        })
      return true
    }
    return false
  })

}

void boot()

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
