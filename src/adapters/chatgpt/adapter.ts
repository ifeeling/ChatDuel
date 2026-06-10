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




// 在所有 frame(同源子 frame)里递归找 file input。
// Gemini 主页的 input 可能嵌在子 frame;ChatGPT 早期版本也有过类似情况。
function findFileInput(): HTMLInputElement | null {
  const candidates = [
    "input[type='file'][accept*='image']",
    "input[type='file'][data-testid*='upload' i]",
    "input[type='file'][aria-label*='upload' i]",
    "input[type='file'][aria-label*='image' i]",
    "input[type='file'][aria-label*='附件' i]",
    "input[type='file'][aria-label*='图片' i]",
    "input[type='file']",
  ]
  function search(doc: Document): HTMLInputElement | null {
    for (const sel of candidates) {
      const el = doc.querySelector<HTMLInputElement>(sel)
      if (el) return el
    }
    // 递归子 frame
    const frames = doc.querySelectorAll<HTMLIFrameElement>('iframe')
    for (const f of frames) {
      try {
        const cw = f.contentWindow
        if (!cw) continue
        const r = search(cw.document)
        if (r) return r
      } catch {
        // 跨源子 frame 不能访问 document,跳过
      }
    }
    return null
  }
  const result = search(document)
  if (!result) {
    // 诊断:扫所有能进的 frame,把 file input 个数报出来,帮排查 selector
    function countInputs(doc: Document, depth: number): number {
      let n = doc.querySelectorAll('input[type=file]').length
      const frames = doc.querySelectorAll('iframe')
      for (const fr of frames) {
        try {
          n += countInputs(fr.contentWindow!.document, depth + 1)
        } catch {/* 跨源 */}
      }
      return n
    }
    console.warn('[AIChatRoom] no file input found. frames inspected, total file inputs =', countInputs(document, 0))
  }
  return result
}

async function attachImageToFileInput(_unusedSel: string, file: File): Promise<boolean> {
  // file input 可能是延迟插入的(点完按钮才出现),重试 5 秒
  const start = Date.now()
  while (Date.now() - start < 5000) {
    const input = findFileInput()
    if (input) {
      const dt = new DataTransfer()
      dt.items.add(file)
      input.files = dt.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

// 等 ChatGPT 上传流水线跑完(没图时不做事)。
// 标志: send 按钮变 enabled + input 旁边出现缩略图(图片 input dataURL)
async function waitForUploadReady(maxMs = 3000): Promise<void> {
  if (!document.querySelector("input[type='file']")) return
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    // 缩略图出现就视为就绪
    const hasThumb = document.querySelector('img[src^="data:"]')
    const sendBtn = document.querySelector<HTMLButtonElement>("button[data-testid='send-button']")
    if (hasThumb && sendBtn && !sendBtn.disabled) return
    await new Promise((r) => setTimeout(r, 100))
  }
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

    async sendMessage(text: string, image?: File) {
      await this.writeText(text)
      // 写完文字再附加图片(等 React/Quill 状态稳定)
      await new Promise((r) => setTimeout(r, 50))
      if (image) await this.attachImage(image)
      // 等上传组件把缩略图渲染进 input,并等 AI 网站自己的图片处理流水线跑完
      // (ChatGPT/Gemini 在收到文件后还要走内部转码/特征抽取)
      await waitForUploadReady()
      // 给 React/ProseMirror 一个微任务让状态更新,再点发送按钮
      await this.triggerSend()
    },

    async attachImage(file: File) {
      if (await attachImageToFileInput(S.fileInput, file)) return  // S.fileInput 保留以备后续精确化
      throw new Error('file input not found for image upload')
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
