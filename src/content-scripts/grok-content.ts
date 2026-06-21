import type { ContentToSw, SwToContent } from '../shared/messages'
import type { AIPlatform, ConversationState } from '../types'
import { createGrokAdapter } from '../adapters/grok/adapter'
import { loadSelectorOverrides } from './selector-overrides'

const PLATFORM: AIPlatform = 'grok'

async function boot() {
  const adapter = createGrokAdapter(await loadSelectorOverrides(PLATFORM))

  function hasUsableComposer(): boolean {
    return !!document.querySelector([
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ].join(','))
  }

  function getProbeState(): ConversationState {
    if (hasUsableComposer()) return { status: 'idle' }
    return { status: 'queued', errorMessage: 'Grok 页面已注入，但尚未识别到输入框' }
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
    const data = e.data as
      | { source?: string; action?: string; text?: string }
      | undefined
    if (!data || data.source !== 'aichatroom-parent') return

    if (data.action === 'get-state') {
      adapter.getConversationState()
        .then((state) => replyToParent(e, state.status === 'error' ? getProbeState() : state))
        .catch(() => replyToParent(e, getProbeState()))
      return
    }
    if (data.action === 'get-last-response') {
      adapter.getLastResponse()
        .then((text) => {
          e.source?.postMessage(
            { source: 'aichatroom-content', type: 'last-response', platform: PLATFORM, text },
            { targetOrigin: '*' },
          )
        })
        .catch(() => {
          e.source?.postMessage(
            { source: 'aichatroom-content', type: 'last-response', platform: PLATFORM, text: '' },
            { targetOrigin: '*' },
          )
        })
      return
    }
    if (data.action === 'get-location') {
      e.source?.postMessage(
        { source: 'aichatroom-content', type: 'location', platform: PLATFORM, href: location.href },
        { targetOrigin: '*' },
      )
      return
    }
    if (data.action === 'write-and-send') {
      const text = data.text ?? ''
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
      adapter.getLastResponse()
        .then((text) => {
          const reply: ContentToSw = { type: 'last-response', platform: PLATFORM, text }
          sendResponse(reply)
        })
        .catch(() => {
          const reply: ContentToSw = { type: 'last-response', platform: PLATFORM, text: '' }
          sendResponse(reply)
        })
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
}

void boot()
