import type { AIAdapter } from '../base'
import type { ConversationState, StreamEvent } from '../../types'
import selectorsJson from './selectors.json'

const S = selectorsJson.selectors

// chatgpt.com 的输入框是 contenteditable div(ProseMirror/TipTap 风格),
// 不是 textarea。contenteditable 的内容本来就在 DOM 里,没有 React state
// 包装层(ProseMirror 用 MutationObserver 监听 DOM 变化),所以**不需要**
// 走原生 value setter,直接 .textContent = + dispatch input 事件即可。
//
// 【发送】与 Gemini 不同:ChatGPT 的提交由 React 18 合成 click 驱动,
// btn.click() 即可工作(React 18 通过 document 上的事件委托接收原生
// click 并派发合成事件;对 click 事件 isTrusted 不严格检查)。
// 详见 docs/postmortems/2026-06-09-gemini-send-button.md §4
//
// ⚠️ 不能调 el.focus():跑在跨源 iframe 子 frame 里时 Chrome 会拒绝
// 跨源子 frame 的 textarea 主动 focus,抛 "Blocked autofocusing on a
// <textarea> element in a cross-origin subframe"。详见
// docs/postmortems/2026-06-09-iframe-no-response.md §2.3
function writeEditableValue(el: HTMLElement, text: string): void {
  // 清空并写入新文本
  el.textContent = text
  // contenteditable 需要 input 事件 + 可选 blur 来让内部框架感知变化
  el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
  // ProseMirror/TipTap 还会监听 beforeinput,补一发
  const beforeInput = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text })
  el.dispatchEvent(beforeInput)
}

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
      writeEditableValue(box, text)
    },

    async triggerSend() {
      const btn = q<HTMLButtonElement>(S.sendButton)
      if (!btn) throw new Error('send button not found')
      // 强制启用(有些情况下 disabled 属性残留)
      if (btn.disabled) btn.disabled = false
      btn.click()
    },

    async sendMessage(text: string) {
      await this.writeText(text)
      // 给 React/ProseMirror 一个微任务让状态更新,再点发送按钮
      await new Promise((r) => setTimeout(r, 100))
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
