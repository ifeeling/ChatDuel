import type { AIAdapter } from '../base'
import type { ConversationState, StreamEvent } from '../../types'
import { mergeSelectorOverrides, type SelectorOverrideMap } from '../../lib/remote-selector-config'
import selectorsJson from './selectors.json'

type ClaudeSelectors = typeof selectorsJson.selectors
const DEFAULT_SELECTORS = selectorsJson.selectors
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ===========================================================================
// 重要：Claude 适配器的 DOM 选择器写在同目录 selectors.json 里，是「最佳猜测」，
// 因为 Claude 官网(Figma/ProseMirror)没有稳定的语义标记。真实页面请以
// 扩展文档里的「Claude 接入验证清单」为准，在浏览器里实测后回填选择器。
//
// 已知历史坑(见 docs/postmortems/2026-06-19-claude-integration-notes.md)：
//   - Claude 在扩展 iframe 里曾经卡在不可用旧模型、模型菜单不生成选项。
//     这是 Claude 官网在 iframe 环境的行为，适配器层无法修复，需实页验证。
//   - 发送按钮可能没有稳定 aria-label，所以 findSendButton 内置 composer 兜底。
//   - 回答区可能没有语义标记，getLatestResponseText 有多种兜底 + 降噪。
// ===========================================================================

// Claude 输入框是 contenteditable（ProseMirror/TipTap 风格），和 ChatGPT 类似：
// 直接改 textContent + 派发 input/beforeinput，框架靠 MutationObserver 感知。
function writeEditableValue(el: HTMLElement, text: string): void {
  el.textContent = text
  el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
  el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
}

function isButtonDisabled(btn: HTMLButtonElement): boolean {
  return btn.disabled || btn.getAttribute('aria-disabled') === 'true' || btn.dataset.disabled === 'true'
}

// 在所有 frame 里递归找 file input（Claude 的图片/附件上传）。
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
  return search(document)
}

async function attachImageToFileInput(_unusedSel: string, file: File): Promise<boolean> {
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

// 等 Claude 上传流水线跑完（没图时不做事）。Claude 不一定用 data: 缩略图，
// 所以只要过了一小段时间或 file input 消失就认为就绪。
async function waitForUploadReady(maxMs = 4000): Promise<void> {
  if (!document.querySelector("input[type='file']")) return
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const input = findFileInput()
    if (!input) return
    await sleep(150)
  }
}

// 找发送按钮：优先用选择器；找不到或禁用时，在 composer 容器里取最后一个
// 未禁用的 button / [role=button]，并跳过附件(上传)按钮。
function findComposerContainer(): HTMLElement | null {
  const box = document.querySelector<HTMLElement>(DEFAULT_SELECTORS.inputBox)
  if (!box) return null
  return (
    box.closest('form') ??
    box.closest("[data-testid='composer']") ??
    box.parentElement?.parentElement ??
    null
  )
}

function findSendButton(): HTMLButtonElement | null {
  const primary = document.querySelector<HTMLButtonElement>(DEFAULT_SELECTORS.sendButton)
  if (primary && !isButtonDisabled(primary)) return primary
  const container = findComposerContainer()
  if (!container) return null
  const buttons = Array.from(container.querySelectorAll<HTMLElement>('button, [role="button"]'))
  for (let i = buttons.length - 1; i >= 0; i--) {
    const b = buttons[i] as HTMLButtonElement
    if (isButtonDisabled(b)) continue
    const label = (b.getAttribute('aria-label') || '').toLowerCase()
    if (label.includes('attach') || label.includes('upload') || label.includes('附件') || label.includes('上传') || label.includes('paperclip')) continue
    return b
  }
  return null
}

async function waitForSendButtonReady(maxMs = 8000): Promise<HTMLButtonElement> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const btn = findSendButton()
    if (btn && !isButtonDisabled(btn)) return btn
    await sleep(100)
  }
  throw new Error('claude send button not found')
}

// 输入框里是否还残留文字（未真正提交）。
function composerRemainingText(): string {
  const box = document.querySelector<HTMLElement>(DEFAULT_SELECTORS.inputBox)
  return (box?.textContent ?? '').replace(/\u200b/g, '').trim()
}

// 点击发送没清掉输入框时，聚焦输入框并发 Enter 作为兜底。
async function pressEnterToSend(): Promise<void> {
  const box = document.querySelector<HTMLElement>(DEFAULT_SELECTORS.inputBox)
  if (!box) return
  box.focus()
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
  box.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }))
}

// 回答区降噪：去掉工具进度文案和纯图标行。
function cleanClaudeText(raw: string): string {
  const lines = raw.split('\n')
  const cleaned = lines.filter((line) => {
    const t = line.trim()
    if (!t) return false
    if (/^Fetching\s+[\w\s-]*\s+data$/i.test(t)) return false
    if (/^Searched the web(, used a tool)?$/i.test(t)) return false
    // 纯图标/符号行：没有任何字母数字
    if (/^[\s\p{So}\p{P}\p{S}]+$/u.test(t)) return false
    return true
  })
  return cleaned.join('\n').trim()
}

// Claude 有时把回答标成 "Claude responded:"，后面紧跟回答块。
function findClaudeRespondedBlock(): string | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>('*'))
  for (const el of all) {
    if (el.childNodes.length === 1 && el.textContent?.trim() === 'Claude responded:') {
      const next = el.nextElementSibling
      if (next?.textContent) return next.textContent
    }
  }
  return null
}

// 从 main 里取最后一个看起来像回答的容器，作为最终兜底。
function findLastResponseFromMain(): string | null {
  const main = document.querySelector<HTMLElement>('main')
  if (!main) return null
  const blocks = Array.from(
    main.querySelectorAll<HTMLElement>("[data-testid='assistant-message'], article[role='article'], .font-claude-message"),
  )
  if (blocks.length) return blocks[blocks.length - 1].textContent ?? null
  const children = Array.from(main.children) as HTMLElement[]
  for (let i = children.length - 1; i >= 0; i--) {
    const text = children[i].textContent ?? ''
    if (text.replace(/\s/g, '').length > 20) return text
  }
  return null
}

function getLatestResponseText(): string {
  const candidates: string[] = []
  const explicit = document.querySelector<HTMLElement>(DEFAULT_SELECTORS.lastResponse)
  if (explicit?.textContent) candidates.push(explicit.textContent)
  const marked = findClaudeRespondedBlock()
  if (marked) candidates.push(marked)
  const fromMain = findLastResponseFromMain()
  if (fromMain) candidates.push(fromMain)
  let best = ''
  for (const c of candidates) {
    const cleaned = cleanClaudeText(c)
    if (cleaned.length > best.length) best = cleaned
  }
  return best
}

function hasStopGeneratingButton(): boolean {
  return !!document.querySelector(DEFAULT_SELECTORS.stopButton)
}

export function createClaudeAdapter(selectorOverrides?: SelectorOverrideMap): AIAdapter {
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
    observer = new MutationObserver(() => {
      dirty = true
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    pollTimer = setInterval(() => {
      if (!dirty || !lastEventHandler) return
      dirty = false
      const text = getLatestResponseText()
      lastEventHandler({ type: 'token', platform: 'claude', text, timestamp: Date.now() })
    }, 150)
  }

  function startContinuePolling() {
    continuePollTimer = setInterval(() => {
      const btn = q(S.continueButton)
      const hasButton = !!btn
      if (hasButton && !lastContinueButtonState) {
        lastContinueButtonState = true
        lastEventHandler?.({ type: 'paused', platform: 'claude', timestamp: Date.now() })
      } else if (!hasButton) {
        lastContinueButtonState = false
      }
    }, 1000)
  }

  return {
    isLoggedIn() {
      return Promise.resolve(!!q(S.loggedIn) || !!document.querySelector("[data-testid='user-menu']"))
    },

    async writeText(text: string) {
      const box = q<HTMLElement>(S.inputBox)
      if (!box) throw new Error('claude input box not found')
      writeEditableValue(box, text)
    },

    async triggerSend() {
      const btn = await waitForSendButtonReady()
      btn.click()
    },

    async sendMessage(text: string, image?: File) {
      await this.writeText(text)
      await new Promise((r) => setTimeout(r, 50))
      if (image) {
        await this.attachImage(image)
        await waitForUploadReady()
      }
      let submitted = false
      for (let attempt = 0; attempt < 3 && !submitted; attempt += 1) {
        await this.triggerSend()
        await new Promise((r) => setTimeout(r, 350))
        if (composerRemainingText().length === 0) {
          submitted = true
          break
        }
        // 兜底：聚焦输入框发 Enter
        await pressEnterToSend()
        await new Promise((r) => setTimeout(r, 350))
        if (composerRemainingText().length === 0) {
          submitted = true
          break
        }
      }
      if (!submitted) throw new Error('claude message did not submit')
    },

    async attachImage(file: File) {
      if (await attachImageToFileInput(S.fileInput, file)) return
      throw new Error('file input not found for claude image upload')
    },

    getLastResponse() {
      return Promise.resolve(getLatestResponseText())
    },

    getConversationState(): Promise<ConversationState> {
      const lastText = getLatestResponseText()
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
