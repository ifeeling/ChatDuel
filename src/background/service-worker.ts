import type { PopupToSw, SwToPopup, SwToContent, ContentToSw } from '../shared/messages'
import type { AIPlatform } from '../types'

// §2.5: must call setAccessLevel before content scripts can access storage.session
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch((e) => console.error('[AIChatRoom] setAccessLevel failed', e))

interface SessionState {
  activeConversationId?: string
  chatgpt?: { status: string; lastResponseHash?: string; startTime?: number }
  gemini?: { status: string; lastResponseHash?: string; startTime?: number }
}

const STORAGE_KEY = 'runtime-state'

async function loadState(): Promise<SessionState> {
  const r = await chrome.storage.session.get(STORAGE_KEY)
  return (r[STORAGE_KEY] as SessionState | undefined) ?? {}
}

async function saveState(state: SessionState): Promise<void> {
  await chrome.storage.session.set({ [STORAGE_KEY]: state })
}

async function findTabFor(platform: AIPlatform): Promise<chrome.tabs.Tab | null> {
  const patterns: Record<AIPlatform, RegExp> = {
    chatgpt: /^https:\/\/chatgpt\.com\//,
    gemini: /^https:\/\/gemini\.google\.com\//,
  }
  const tabs = await chrome.tabs.query({ url: patterns[platform].source })
  return tabs[0] ?? null
}

async function sendToTab<T>(tabId: number, msg: SwToContent): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else resolve(response as T)
    })
  })
}

// Listen for content script uploads
chrome.runtime.onMessage.addListener((msg: ContentToSw, _sender, _sendResponse) => {
  if (msg.type === 'stream-event') {
    const reply: SwToPopup = { type: 'stream-event', event: msg.event }
    chrome.runtime.sendMessage(reply).catch(() => {/* popup may be closed */})
    return false
  }
  return false
})

// Listen for popup requests
chrome.runtime.onMessage.addListener((msg: PopupToSw, _sender, sendResponse) => {
  if (msg.type === 'send-message') {
    ;(async () => {
      const state = await loadState()
      const newState: SessionState = { ...state, activeConversationId: crypto.randomUUID() }
      for (const p of msg.platforms) {
        const tab = await findTabFor(p)
        if (!tab?.id) {
          sendResponse({ ok: false, error: `${p} tab not found` })
          return
        }
        newState[p] = { status: 'sending', startTime: Date.now() }
        await saveState(newState)
        try {
          await sendToTab(tab.id, { type: 'write-and-send', text: msg.text, imageDataUrl: msg.imageDataUrl })
        } catch (e) {
          sendResponse({ ok: false, error: String(e) })
          return
        }
      }
      sendResponse({ ok: true })
    })()
    return true
  }
  if (msg.type === 'get-conversation-state') {
    ;(async () => {
      const tab = await findTabFor(msg.platform)
      if (!tab?.id) {
        sendResponse({ ok: false, error: 'tab not found' })
        return
      }
      const state = await sendToTab<{ type: 'state'; platform: AIPlatform; state: unknown }>(tab.id, { type: 'get-state' })
      sendResponse({ ok: true, state })
    })()
    return true
  }
  return false
})
