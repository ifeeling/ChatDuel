import type { AIAdapter } from '../base'
import type { ConversationState, StreamEvent } from '../../types'
import selectorsJson from './selectors.json'

const S = selectorsJson.selectors

export function createChatGPTAdapter(): AIAdapter {
  let lastEventHandler: ((e: StreamEvent) => void) | null = null
  let observer: MutationObserver | null = null
  let dirty = false
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let continuePollTimer: ReturnType<typeof setInterval> | null = null
  let lastContinueButtonState = false

  function q<T extends Element = Element>(sel: string): T | null {
    return document.querySelector<T>(sel)
  }

  function startObserver() {
    observer = new MutationObserver(() => { dirty = true })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    pollTimer = setInterval(() => {
      if (!dirty || !lastEventHandler) return
      dirty = false
      const text = q(S.lastResponse)?.textContent ?? ''
      lastEventHandler({ type: 'token', platform: 'chatgpt', text, timestamp: Date.now() })
    }, 150)
  }

  function startContinuePolling() {
    continuePollTimer = setInterval(() => {
      const btn = q(selectorsJson.selectors.continueButton)
      const hasButton = !!btn
      if (hasButton && !lastContinueButtonState) {
        lastContinueButtonState = true
        lastEventHandler?.({ type: 'paused', platform: 'chatgpt', timestamp: Date.now() })
      } else if (!hasButton) {
        lastContinueButtonState = false
      }
    }, 1000)
  }

  return {
    isLoggedIn() {
      return Promise.resolve(!!q(S.loggedIn))
    },

    async writeText(text: string) {
      const box = q<HTMLElement>(S.inputBox)
      if (!box) throw new Error('input box not found')
      box.focus()
      if (box.getAttribute('contenteditable') === 'true') {
        box.textContent = text
        box.dispatchEvent(new InputEvent('input', { bubbles: true }))
      } else {
        ;(box as HTMLTextAreaElement).value = text
        box.dispatchEvent(new InputEvent('input', { bubbles: true }))
      }
    },

    async triggerSend() {
      const btn = q<HTMLButtonElement>(S.sendButton)
      if (!btn) throw new Error('send button not found')
      btn.click()
    },

    async sendMessage(text: string) {
      await this.writeText(text)
      await this.triggerSend()
    },

    getLastResponse() {
      return Promise.resolve(q(S.lastResponse)?.textContent ?? '')
    },

    getConversationState(): Promise<ConversationState> {
      const last = q(S.lastResponse)?.textContent ?? ''
      if (!last) return Promise.resolve({ status: 'idle' })
      return Promise.resolve({ status: 'finished', lastResponse: last })
    },

    onStreamEvent(handler) {
      lastEventHandler = handler
      startObserver()
      startContinuePolling()
      return () => {
        observer?.disconnect()
        observer = null
        if (pollTimer) clearInterval(pollTimer)
        pollTimer = null
        if (continuePollTimer) clearInterval(continuePollTimer)
        continuePollTimer = null
        lastEventHandler = null
      }
    },

    detectRateLimit() {
      return Promise.resolve(!!q(S.rateLimitToast))
    },
  }
}
