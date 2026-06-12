import type { ContentToSw, SwToContent } from '../shared/messages'
import type { AIPlatform, ConversationState } from '../types'
import { createDoubaoAdapter } from '../adapters/doubao/adapter'

const PLATFORM: AIPlatform = 'doubao'
const adapter = createDoubaoAdapter()

function hasUsableComposer(): boolean {
  return !!document.querySelector([
    'textarea',
    '[contenteditable="true"]',
    '[role="textbox"]',
  ].join(','))
}

function looksLikeLoginPage(): boolean {
  const url = location.href.toLowerCase()
  if (url.includes('login') || url.includes('passport') || url.includes('sso')) return true

  const bodyText = (document.body?.innerText ?? '').slice(0, 2000)
  return /登录|扫码登录|手机号登录|验证码登录/.test(bodyText) && !hasUsableComposer()
}

function getProbeState(): ConversationState {
  if (looksLikeLoginPage()) {
    return { status: 'error', errorMessage: '可能未登录豆包' }
  }
  if (hasUsableComposer()) {
    return { status: 'idle' }
  }
  return { status: 'queued', errorMessage: '豆包页面已注入，但尚未识别到输入框' }
}

function postReadyToParent() {
  if (window.parent === window) return
  try {
    window.parent.postMessage(
      { source: 'aichatroom-content', event: 'ready', platform: PLATFORM },
      { targetOrigin: '*' },
    )
  } catch {
    /* ignore */
  }
}

function replyToParent(e: MessageEvent, state: ConversationState) {
  e.source?.postMessage(
    { source: 'aichatroom-content', type: 'state', platform: PLATFORM, state },
    { targetOrigin: '*' },
  )
}

postReadyToParent()

window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as { source?: string; action?: string } | undefined
  if (!data || data.source !== 'aichatroom-parent') return

  if (data.action === 'get-state') {
    adapter.getConversationState()
      .then((state) => replyToParent(e, state.status === 'error' ? getProbeState() : state))
      .catch(() => replyToParent(e, getProbeState()))
    return
  }
  if (data.action === 'write-and-send') {
    const text = (data as { text?: string }).text ?? ''
    adapter.sendMessage(text)
      .then(() => {
        e.source?.postMessage(
          { source: 'aichatroom-content', event: 'result', action: 'write-and-send', platform: PLATFORM, ok: true },
          { targetOrigin: '*' },
        )
      })
      .catch((err: unknown) => {
        e.source?.postMessage(
          {
            source: 'aichatroom-content',
            event: 'result',
            action: 'write-and-send',
            platform: PLATFORM,
            ok: false,
            error: String(err),
          },
          { targetOrigin: '*' },
        )
      })
  }
})

chrome.runtime.onMessage.addListener((msg: SwToContent, _sender, sendResponse) => {
  if (msg.type === 'get-state') {
    adapter.getConversationState()
      .then((state) => {
        const reply: ContentToSw = { type: 'state', platform: PLATFORM, state: state.status === 'error' ? getProbeState() : state }
        sendResponse(reply)
      })
      .catch(() => {
        const reply: ContentToSw = { type: 'state', platform: PLATFORM, state: getProbeState() }
        sendResponse(reply)
      })
    return true
  }
  if (msg.type === 'get-last-response') {
    const reply: ContentToSw = { type: 'last-response', platform: PLATFORM, text: '' }
    sendResponse(reply)
    return true
  }
  if (msg.type === 'write-and-send') {
    adapter
      .sendMessage(msg.text)
      .then(() => sendResponse({ ok: true }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }))
    return true
  }
  return false
})
