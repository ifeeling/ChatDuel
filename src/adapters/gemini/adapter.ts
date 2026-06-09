import type { AIAdapter } from '../base'
import type { ConversationState, StreamEvent } from '../../types'
import selectorsJson from './selectors.json'

const S = selectorsJson.selectors

// gemini.google.com 的输入框是 div.ql-editor(Quill 富文本)。
//
// 【写值】Quill 内部 state 在 JS 内存中,直接 textContent = + dispatch
//  input 事件 Quill 不会同步内部 state。可靠方案:innerHTML 设成 Quill
//  期望的 <p>...</p> 格式 + 派发 inputType: insertFromPaste 的 InputEvent。
//
// 【发送】Gemini 内部 send 监听在 ql-editor 上的 keydown Enter(Quill
//  内部 keydown 驱动),不走 React 18 合成 click 路径。所以:
//  - btn.click() ✗ (React 18 收到 click 但 Quill 内部 state 没同步)
//  - 派发 PointerEvent 序列 ✗
//  - 找 React onClick 直接调 ✗ (onClick 真的只是个 UI 反馈,不是真提交)
//  - 派发 keydown Enter 到 ql-editor ✓ (Quill 立即处理并提交)
// 关键参数:keyCode:13 + which:13 + bubbles:true + composed:true
//
// 详细复盘见 docs/postmortems/2026-06-09-gemini-send-button.md

function writeQuillValue(el: HTMLElement, text: string): void {
  const html = text
    .split('\n')
    .map((line) => (line.length === 0 ? '<p><br></p>' : `<p>${escapeHtml(line)}</p>`))
    .join('')
  el.innerHTML = html
  el.dispatchEvent(
    new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: text }),
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// 派发 keydown Enter 触发 Gemini 的 send 监听
function dispatchEnterKey(el: HTMLElement): void {
  // Gemini 是 contenteditable,keydown 派发到它(用户实测有效)
  const init: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    composed: true,
  }
  el.dispatchEvent(new KeyboardEvent('keydown', init))
}

export function createGeminiAdapter(): AIAdapter {
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
      lastEventHandler({ type: 'token', platform: 'gemini', text, timestamp: Date.now() })
    }, 150)
  }

  function startContinuePolling() {
    continuePollTimer = setInterval(() => {
      const btn = q(selectorsJson.selectors.continueButton)
      const hasButton = !!btn
      if (hasButton && !lastContinueButtonState) {
        lastContinueButtonState = true
        lastEventHandler?.({ type: 'paused', platform: 'gemini', timestamp: Date.now() })
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
      writeQuillValue(box, text)
    },

    async triggerSend() {
      // Gemini send = keydown Enter(用户实测有效)
      const box = q<HTMLElement>(S.inputBox)
      if (box) {
        dispatchEnterKey(box)
        return
      }
      // 退路:button.click
      const btn = q<HTMLButtonElement>('button.submit') ?? q<HTMLButtonElement>(S.sendButton)
      if (!btn) throw new Error('send button not found')
      if (btn.disabled) btn.disabled = false
      btn.click()
    },

    async sendMessage(text: string) {
      await this.writeText(text)
      // Quill 同步需要时间
      await new Promise((r) => setTimeout(r, 200))
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
