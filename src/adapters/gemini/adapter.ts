import type { AIAdapter } from '../base'
import type { ConversationState, StreamEvent } from '../../types'
import { mergeSelectorOverrides, type SelectorOverrideMap } from '../../lib/remote-selector-config'
import selectorsJson from './selectors.json'

type GeminiSelectors = typeof selectorsJson.selectors
const DEFAULT_SELECTORS = selectorsJson.selectors
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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





// 把图片以 paste 事件 + clipboardData 方式注入 ql-editor(Quill 接管)
// Gemini 用的是 Quill 富文本,paste 事件会触发 Quill 的内部 paste handler
// (modules/clipboard),handler 会读取 clipboardData 里的 image/* item,
// 转 base64 嵌入 Delta。文档明确支持这条路。
async function pasteImageIntoEditor(file: File): Promise<boolean> {
  const editor = document.querySelector<HTMLElement>('div.ql-editor[contenteditable="true"]')
  if (!editor) return false
  // 必须 focus,Quill 的 paste 监听依赖光标位置
  editor.focus()
  // 等一个 tick
  await sleep(50)

  // 构造 DataTransfer,把 file 放进去
  const dt = new DataTransfer()
  dt.items.add(file)

  // 派发 paste 事件,clipboardData 携带我们的文件
  const evt = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: dt,
  } as unknown as ClipboardEventInit)
  // 某些浏览器 ClipboardEvent 的 clipboardData 只读,Object.defineProperty 兜底
  try {
    Object.defineProperty(evt, 'clipboardData', { value: dt, configurable: true })
  } catch {/* ignore */}
  editor.dispatchEvent(evt)
  return true
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
    await sleep(250)
  }
  return false
}

// 等 Gemini 上传流水线跑完。
// 标志: ql-editor 里出现 <img> 子节点(图片被插到富文本里),或 input 出现缩略图
async function waitForUploadReady(maxMs = 3000): Promise<void> {
  const editor = document.querySelector('div.ql-editor[contenteditable="true"]')
  if (!editor) return
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    // Gemini 把上传的图片以 <img> 节点插入 ql-editor
    const hasImg = editor.querySelector('img')
    if (hasImg) return
    await sleep(100)
  }
}

function hasStopGeneratingButton(): boolean {
  const candidates = [
    "button[aria-label*='stop' i]",
    "button[aria-label*='停止' i]",
    'button.stop',
  ]
  return candidates.some((selector) => !!document.querySelector(selector))
}

function editorHasPendingContent(editor: HTMLElement): boolean {
  const text = editor.textContent?.replace(/\u200b/g, '').trim() ?? ''
  return text.length > 0 || !!editor.querySelector('img')
}

async function waitForSendAccepted(editor: HTMLElement, maxMs = 700): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (hasStopGeneratingButton() || !editorHasPendingContent(editor)) return true
    await sleep(100)
  }
  return hasStopGeneratingButton() || !editorHasPendingContent(editor)
}

export function createGeminiAdapter(selectorOverrides?: SelectorOverrideMap): AIAdapter {
  const S = mergeSelectorOverrides(DEFAULT_SELECTORS, selectorOverrides)
  let lastEventHandler: ((e: StreamEvent) => void) | null = null
  let observer: MutationObserver | null = null
  let dirty = false
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let continuePollTimer: ReturnType<typeof setInterval> | null = null
  let lastContinueButtonState = false

  function q<T extends Element = Element>(sel: string): T | null {
    return document.querySelector<T>(sel)
  }

  function last<T extends Element = Element>(sel: string): T | null {
    const nodes = document.querySelectorAll<T>(sel)
    return nodes.length > 0 ? nodes[nodes.length - 1] : null
  }

  function startObserver() {
    observer = new MutationObserver(() => { dirty = true })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    pollTimer = setInterval(() => {
      if (!dirty || !lastEventHandler) return
      dirty = false
      const text = last(S.lastResponse)?.textContent ?? ''
      lastEventHandler({ type: 'token', platform: 'gemini', text, timestamp: Date.now() })
    }, 150)
  }

  function startContinuePolling() {
    continuePollTimer = setInterval(() => {
      const btn = q(S.continueButton)
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
        for (let attempt = 0; attempt < 3; attempt += 1) {
          dispatchEnterKey(box)
          if (await waitForSendAccepted(box)) return
          await sleep(250)
        }
        throw new Error('message was not accepted by Gemini editor')
      }
      // 退路:button.click
      const btn = q<HTMLButtonElement>('button.submit') ?? q<HTMLButtonElement>(S.sendButton)
      if (!btn) throw new Error('send button not found')
      btn.click()
    },

    async sendMessage(text: string, image?: File) {
      await this.writeText(text)
      // 写完文字再附加图片(等 React/Quill 状态稳定)
      await sleep(50)
      if (image) {
        await this.attachImage(image)
        // 等上传组件把缩略图渲染进 input,并等 AI 网站自己的图片处理流水线跑完
        // (ChatGPT/Gemini 在收到文件后还要走内部转码/特征抽取)
        await waitForUploadReady()
      }
      // Quill 同步需要时间
      await sleep(200)
      await this.triggerSend()
    },

    async attachImage(file: File) {
      // 路径 1: 找原生 file input 并注入(ChatGPT 走这条)
      if (await attachImageToFileInput(S.fileInput, file)) return
      // 路径 2: Gemini 2026+ 把上传按钮封在 Angular xapfileselectortrigger 组件里,DOM 不暴露 file input。
      //   退而求其次:派发 paste 事件到 ql-editor,Quill 的 paste handler 会把图片作为 base64 嵌入。
      if (await pasteImageIntoEditor(file)) return
      throw new Error('file input not found and paste fallback failed for image upload')
    },

        getLastResponse() {
      return Promise.resolve(last(S.lastResponse)?.textContent ?? '')
    },

    getConversationState(): Promise<ConversationState> {
      const lastText = last(S.lastResponse)?.textContent ?? ''
      if (hasStopGeneratingButton()) return Promise.resolve({ status: 'streaming', lastResponse: lastText })
      if (q(S.continueButton)) return Promise.resolve({ status: 'paused', lastResponse: lastText })
      if (!lastText) return Promise.resolve({ status: 'idle' })
      return Promise.resolve({ status: 'finished', lastResponse: lastText })
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
