import type { AIAdapter, AdapterDiagnostics } from '../base'
import type { ConversationState, StreamEvent } from '../../types'
import { mergeSelectorOverrides, type SelectorOverrideMap } from '../../lib/remote-selector-config'
import selectorsJson from './selectors.json'

type ClaudeSelectors = typeof selectorsJson.selectors
const DEFAULT_SELECTORS = selectorsJson.selectors
export const CLAUDE_SELECTOR_VERSION = selectorsJson.version
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

// 回答区降噪：去掉工具进度文案、纯图标行以及行尾的图标字体残留。
function cleanClaudeText(raw: string): string {
  const lines = raw.split('\n')
  const cleaned = lines
    .filter((line) => {
      const t = line.trim()
      if (!t) return false
      if (/^Fetching\s+[\w\s-]*\s+data$/i.test(t)) return false
      if (/^Searched the web(, used a tool)?$/i.test(t)) return false
      // 纯图标/符号行：没有任何字母数字
      if (/^[\s\p{So}\p{P}\p{S}]+$/u.test(t)) return false
      return true
    })
    .map((line) => {
      // 去掉行尾由图标字体(PUA)或方括号等按钮图标组成的残留尾巴。
      // 保留常见句末标点（。！？.!?…）不受影响；代码中的 arr[0] 也不会被误删，
      // 因为正则只匹配从行尾开始连续都是特殊符号/空白的部分。
      return line.replace(/[\s\[\]\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]+$/gu, '')
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

// ── 选择器无关的 DOM 深度遍历兜底 ───────────────────────────────────
//
// 当 selectors.json 的选择器全部 MISS（当前 Claude 实页就是这种情况），
// 需要走"暴力"路线：在 main / body 里找到最像"AI 回答"的文本块。
//
// 策略（按优先级）：
//   1. 找包含 "Thought for" 或以 "Claude" 开头的消息容器（Claude 特有标记）
//   2. 在 main 中找最后一个 textContent 足够长（>30 字符）的非输入区容器
//   3. 找 role="article" 或含 assistant/ai 关键词的 aria-label 元素
//   4. 兜底：取 main 内倒数第二个有实质内容的子元素

function findResponseByDomWalk(): string | null {
  const root = document.querySelector('main') || document.body
  if (!root) return null

  // 策略 1：找 Claude 特有标记（"Thought for Ns" 前缀、Claude 标签）
  const allElements = Array.from(root.querySelectorAll<HTMLElement>('*'))
  for (let i = allElements.length - 1; i >= 0; i--) {
    const el = allElements[i]
    const text = el.textContent?.trim() ?? ''
    // 跳过太短或太大的（大的是 root 容器本身）
    if (text.length < 30 || text.length > 10000) continue
    // "Thought for Xs" 是 Claude 思考过程的前缀，说明这是回答区
    if (/^Thought for \d+[sm]/.test(text)) {
      const cleaned = cleanClaudeText(text)
      if (cleaned.length > 10) return cleaned
    }
  }

  // 策略 2：找 data-testid 含 assistant / message 的元素
  for (const sel of [
    "[data-testid*='assistant']",
    "[data-testid*='message']",
    "[data-testid*='response']",
    "article[role='article']",
    "[role='presentation'] [class*='message']",
    "[class*='font-claude-message']",
  ]) {
    const nodes = Array.from(root.querySelectorAll<HTMLElement>(sel))
    if (nodes.length > 0) {
      const last = nodes[nodes.length - 1]
      const cleaned = cleanClaudeText(last.textContent ?? '')
      if (cleaned.length > 10) return cleaned
    }
  }

  // 策略 3：找含 AI 回答特征 aria-label 的容器
  for (const el of allElements) {
    const label = el.getAttribute('aria-label') || ''
    if (/response|answer|assistant|claude|ai/i.test(label)) {
      const cleaned = cleanClaudeText(el.textContent ?? '')
      if (cleaned.length > 10) return cleaned
    }
  }

  // 策略 4：在 main 的直接/间接子元素中，找最后一个够长的文本块
  // 排除输入框区域（contenteditable / textarea / input）
  const children = Array.from(root.querySelectorAll<HTMLElement>(':scope > *, :scope > * > *'))
  for (let i = children.length - 1; i >= 0; i--) {
    const el = children[i]
    // 跳过输入相关区域
    if (el.querySelector('input, textarea, [contenteditable], [data-testid*="chat-input"], [data-testid*="composer"]')) continue
    if (el.matches('input, textarea, [contenteditable], [role="textbox"]')) continue
    const text = el.textContent?.trim() ?? ''
    if (text.replace(/\s/g, '').length > 20) {
      const cleaned = cleanClaudeText(text)
      if (cleaned.length > 10) return cleaned
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

// 判断一个消息 article 是否为 AI 回复：
// Claude 为屏幕阅读器在每条消息 article 的 textContent 前缀注入
// "Claude responded:"（AI 回复）或 "You said:"（用户提问），这是稳定标记。
function isAiResponseArticle(article: HTMLElement | null): boolean {
  if (!article) return false
  const text = (article.textContent ?? '').trim()
  return /^claude responded:/i.test(text)
}

// 去掉 Claude 注入的 accessibility 前缀（"You said:" / "Claude responded:"），
// 让记录里只保留真正的消息正文。
function stripMessagePrefix(text: string): string {
  return text.replace(/^\s*(You said:|Claude responded:)\s*/i, '').trim()
}

// 用 Claude 官方支持的 data-last-message 标记取「最新一条消息」；
// 若最新消息是用户提问（AI 还没回答），则倒序遍历所有消息，
// 取最新一条 AI 回复。返回去除前缀后的干净文本。
function findLatestAiResponse(): string | null {
  // 路径 1：data-last-message 直接命中「最新一条消息」
  const lastMsg = document.querySelector<HTMLElement>("[data-last-message='true']")
  if (lastMsg) {
    const article = lastMsg.querySelector<HTMLElement>("[role='article']") ?? lastMsg
    if (isAiResponseArticle(article)) {
      const cleaned = cleanClaudeText(stripMessagePrefix(article.textContent ?? ''))
      if (cleaned.length > 0) return cleaned
    }
  }
  // 路径 2：倒序遍历所有消息，取最新一条 AI 回复
  // （覆盖「用户刚提问、AI 还没答」导致 data-last-message 标在用户消息上的情况）
  const messages = Array.from(document.querySelectorAll<HTMLElement>("[data-rs-index]"))
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const article = messages[i].querySelector<HTMLElement>("[role='article']") ?? messages[i]
    if (isAiResponseArticle(article)) {
      const cleaned = cleanClaudeText(stripMessagePrefix(article.textContent ?? ''))
      if (cleaned.length > 0) return cleaned
    }
  }
  return null
}

function getLatestResponseText(): string {
  // 优先级 1：Claude 官方 data-last-message 标记 + AI/用户前缀区分（当前实页最准确）
  const viaLastMessage = findLatestAiResponse()
  if (viaLastMessage) return viaLastMessage
  // 其余路径统一收口降噪（cleanClaudeText 幂等，重复调用无害）
  const marked = findClaudeRespondedBlock()
  if (marked) {
    const cleaned = cleanClaudeText(marked)
    if (cleaned.length > 0) return cleaned
  }
  const fromMain = findLastResponseFromMain()
  if (fromMain) {
    const cleaned = cleanClaudeText(fromMain)
    if (cleaned.length > 0) return cleaned
  }
  const domWalk = findResponseByDomWalk()
  if (domWalk) {
    const cleaned = cleanClaudeText(domWalk)
    if (cleaned.length > 0) return cleaned
  }
  return ''
}

function hasStopGeneratingButton(selectors = DEFAULT_SELECTORS): boolean {
  return !!document.querySelector(selectors.stopButton)
}

// ── 基于 MutationObserver 的流式状态检测（选择器无关兜底） ─────────
//
// 当 stopButton/continueButton 选择器全部 MISS 时，
// 用「DOM 最后变化时间」判断是否还在流式输出：
//   - 最近 ~2s 内有 DOM 变化 → streaming
//   - 超过 ~3s 无变化且有回答文本 → finished
//   - 无文本 → idle

let lastMutationTimestamp = 0
let isStreaming = false

export function createClaudeAdapter(selectorOverrides?: SelectorOverrideMap): AIAdapter {
  const S = mergeSelectorOverrides(DEFAULT_SELECTORS, selectorOverrides)
  let lastEventHandler: ((e: StreamEvent) => void) | null = null
  let observer: MutationObserver | null = null
  let dirty = false
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let continuePollTimer: ReturnType<typeof setInterval> | null = null
  let lastContinueButtonState = false
  // 追踪上一次轮询时的文本长度，用于检测"文本是否还在增长"
  let lastPolledTextLength = 0

  function q<T extends Element = Element>(sel: string): T | null {
    return document.querySelector<T>(sel)
  }

  function last<T extends Element = Element>(sel: string): T | null {
    const nodes = document.querySelectorAll<T>(sel)
    return nodes.length > 0 ? nodes[nodes.length - 1] : null
  }

  function emit(diagnostics: AdapterDiagnostics | undefined, event: Parameters<AdapterDiagnostics['reporter']['emit']>[0]) {
    diagnostics?.reporter.emit({ ...event, selectorConfigVersion: diagnostics.selectorConfigVersion })
  }

  function startObserver() {
    observer = new MutationObserver(() => {
      dirty = true
      lastMutationTimestamp = Date.now()
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    pollTimer = setInterval(() => {
      if (!lastEventHandler) return
      const now = Date.now()
      const text = getLatestResponseText()
      const len = text.length

      // 基于文本增长和 DOM 变化判断流式状态（选择器无关）
      if (len > lastPolledTextLength && (now - lastMutationTimestamp < 2000)) {
        if (!isStreaming) {
          isStreaming = true
          lastEventHandler({ type: 'started', platform: 'claude', timestamp: now })
        }
        dirty = false
        lastPolledTextLength = len
        lastEventHandler({ type: 'token', platform: 'claude', text, timestamp: now })
      } else if (dirty) {
        // 有 DOM 变化但文本没长（可能在渲染工具调用等非正文内容）
        dirty = false
        lastEventHandler({ type: 'token', platform: 'claude', text, timestamp: now })
      } else if (isStreaming && len > 0 && (now - lastMutationTimestamp > 3000)) {
        // 超过 3 秒无新 DOM 变化 → 判定流式结束
        isStreaming = false
        lastEventHandler({ type: 'finished', platform: 'claude', text, timestamp: now })
        lastPolledTextLength = len
      }
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

    async sendMessage(text: string, image?: File, diagnostics?: AdapterDiagnostics) {
      const box = q<HTMLElement>(S.inputBox)
      if (!box) {
        emit(diagnostics, {
          component: 'platform-adapter', operation: 'input-locate', stage: 'failed', eventStatus: 'failed',
          runOutcome: 'failed', errorCode: 'input-box-not-found', inputCharacterCount: text.length,
        })
        throw new Error('claude input box not found')
      }
      emit(diagnostics, {
        component: 'platform-adapter', operation: 'input-locate', stage: 'located', eventStatus: 'succeeded', inputCharacterCount: text.length,
      })
      try {
        writeEditableValue(box, text)
      } catch {
        emit(diagnostics, {
          component: 'platform-adapter', operation: 'input-write', stage: 'failed', eventStatus: 'failed',
          runOutcome: 'failed', errorCode: 'input-write-failed', inputCharacterCount: text.length,
        })
        throw new Error('input write failed')
      }
      emit(diagnostics, {
        component: 'platform-adapter', operation: 'input-write', stage: 'written', eventStatus: 'succeeded', inputCharacterCount: text.length,
      })
      await new Promise((r) => setTimeout(r, 50))
      if (image) {
        emit(diagnostics, {
          component: 'platform-adapter', operation: 'attachment-prepare', stage: 'preparing', eventStatus: 'observed', hasAttachment: true,
        })
        try {
          await this.attachImage(image)
          await waitForUploadReady()
        } catch {
          emit(diagnostics, {
            component: 'platform-adapter', operation: 'attachment-prepare', stage: 'failed', eventStatus: 'failed',
            runOutcome: 'failed', errorCode: 'attachment-preparation-timeout', hasAttachment: true,
          })
          throw new Error('attachment preparation failed')
        }
        emit(diagnostics, {
          component: 'platform-adapter', operation: 'attachment-prepare', stage: 'prepared', eventStatus: 'succeeded', hasAttachment: true,
        })
      } else {
        emit(diagnostics, {
          component: 'platform-adapter', operation: 'attachment-prepare', stage: 'skipped', eventStatus: 'skipped', hasAttachment: false,
        })
      }
      let submitted = false
      for (let attempt = 0; attempt < 3 && !submitted; attempt += 1) {
        const retryNumber = attempt + 1
        try {
          await this.triggerSend()
        } catch {
          emit(diagnostics, {
            component: 'platform-adapter', operation: 'send-click', stage: 'timed-out', eventStatus: 'timed-out',
            runOutcome: 'timed-out', errorCode: 'send-button-not-ready', retryNumber, timeoutMs: 8_000,
          })
          throw new Error('send button is not ready')
        }
        emit(diagnostics, {
          component: 'platform-adapter', operation: 'send-click', stage: 'clicked', eventStatus: 'succeeded', retryNumber,
        })
        await new Promise((r) => setTimeout(r, 350))
        if (composerRemainingText().length === 0) {
          submitted = true
          emit(diagnostics, {
            component: 'platform-adapter', operation: 'send-ack', stage: 'accepted', eventStatus: 'succeeded',
            retryNumber, retryCount: retryNumber,
          })
          break
        }
        // 兜底：聚焦输入框发 Enter
        await pressEnterToSend()
        await new Promise((r) => setTimeout(r, 350))
        if (composerRemainingText().length === 0) {
          submitted = true
          emit(diagnostics, {
            component: 'platform-adapter', operation: 'send-ack', stage: 'accepted', eventStatus: 'succeeded',
            retryNumber, retryCount: retryNumber,
          })
          break
        }
      }
      if (!submitted) {
        emit(diagnostics, {
          component: 'platform-adapter', operation: 'send-ack', stage: 'failed', eventStatus: 'failed',
          runOutcome: 'failed', errorCode: 'message-not-accepted', retryCount: 3,
        })
        throw new Error('claude message did not submit')
      }
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
      // 优先用选择器检测（最准确）
      if (hasStopGeneratingButton(S)) return Promise.resolve({ status: 'streaming', lastResponse: lastText, stopButtonDetected: true })
      if (q(S.continueButton)) return Promise.resolve({ status: 'paused', lastResponse: lastText, stopButtonDetected: false })
      // 选择器无关的兜底：基于 DOM 变化时间戳
      const timeSinceMutation = Date.now() - lastMutationTimestamp
      if (isStreaming || timeSinceMutation < 2000) {
        return Promise.resolve({ status: 'streaming', lastResponse: lastText, stopButtonDetected: false })
      }
      if (!lastText) return Promise.resolve({ status: 'idle', stopButtonDetected: false })
      // 有文本、无停止按钮、最近 3 秒无 DOM 变化 → 判定已完成
      return Promise.resolve({ status: 'finished', lastResponse: lastText, stopButtonDetected: false })
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
