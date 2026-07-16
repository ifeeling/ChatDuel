import { createClaudeAdapter } from '../adapters/claude/adapter'
import type { SwToContent, ContentToSw } from '../shared/messages'
import type { AIPlatform } from '../types'
import { loadSelectorOverrides } from './selector-overrides'

// Claude 在扩展 iframe 里点开模型菜单时，浮层可用高度可能被压扁(只剩几 px)，
// 导致菜单外壳可见但选项内容出不来。这里只做一个最小 CSS 补丁：给已展开的
// 菜单强制一个可用高度，并让内部滚动层继承，避免被 iframe 底部压住。
// 具体高度/类名以实页验证为准(见 Claude 接入验证清单)。
function installMenuHeightPatch(): void {
  const style = document.createElement('style')
  style.textContent = `
[data-cds="Menu"][role="menu"][data-open] {
  max-height: 60vh !important;
  min-height: 180px !important;
  overflow-y: auto !important;
}
[data-cds="Menu"][role="menu"][data-open] [class*="overflow"],
[data-cds="Menu"][role="menu"][data-open] [class*="scroll"] {
  max-height: 52vh !important;
  overflow-y: auto !important;
}
`
  document.documentElement.appendChild(style)
}

async function boot() {
  installMenuHeightPatch()
  const adapter = createClaudeAdapter(await loadSelectorOverrides('claude'))

  adapter.onStreamEvent((event) => {
    const msg: ContentToSw = { type: 'stream-event', event }
    chrome.runtime.sendMessage(msg).catch(() => {/* SW may not be ready */})
  })

  if (window.parent !== window) {
    try {
      window.parent.postMessage(
        { source: 'aichatroom-content', event: 'ready', platform: 'claude' },
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
            { source: 'aichatroom-content', type: 'state', platform: 'claude', state },
            { targetOrigin: '*' },
          )
        })
        return
      }
      if (data.action === 'get-last-response') {
        adapter.getLastResponse().then((text) => {
          e.source?.postMessage(
            { source: 'aichatroom-content', type: 'last-response', platform: 'claude', text },
            { targetOrigin: '*' },
          )
        })
        return
      }
      if (data.action === 'get-location') {
        e.source?.postMessage(
          { source: 'aichatroom-content', type: 'location', platform: 'claude', href: location.href },
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
          { source: 'aichatroom-content', event: 'result', action: 'write-and-send', platform: 'claude', ok: true },
          { targetOrigin: '*' },
        )
      })
      .catch((err: unknown) => {
        e.source?.postMessage(
          {
            source: 'aichatroom-content',
            event: 'result',
            action: 'write-and-send',
            platform: 'claude',
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
          const reply: ContentToSw = { type: 'state', platform: 'claude' as AIPlatform, state }
          sendResponse(reply)
        })
      return true
    }
    if (msg.type === 'get-last-response') {
      adapter
        .getLastResponse()
        .then((text) => {
          const reply: ContentToSw = { type: 'last-response', platform: 'claude' as AIPlatform, text }
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
