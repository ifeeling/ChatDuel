import type { ContentToSw, SwToContent } from '../shared/messages'
import type { AIPlatform, ConversationState } from '../types'

const PLATFORM: AIPlatform = 'doubao'

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
    replyToParent(e, getProbeState())
  }
})

chrome.runtime.onMessage.addListener((msg: SwToContent, _sender, sendResponse) => {
  if (msg.type === 'get-state') {
    const reply: ContentToSw = { type: 'state', platform: PLATFORM, state: getProbeState() }
    sendResponse(reply)
    return true
  }
  if (msg.type === 'get-last-response') {
    const reply: ContentToSw = { type: 'last-response', platform: PLATFORM, text: '' }
    sendResponse(reply)
    return true
  }
  if (msg.type === 'write-and-send') {
    sendResponse({ ok: false, error: '豆包文本发送尚未接入' })
    return true
  }
  return false
})
