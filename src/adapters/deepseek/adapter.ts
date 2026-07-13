import type { AIAdapter } from '../base'
import type { ConversationState, StreamEvent } from '../../types'
import { buildDataTransferFromFile, dispatchPaste } from '../../lib/image-handler'
import { elementToMarkdownText } from '../../lib/dom-response-text'
import { describeCaptureElement, logCaptureDebug } from '../../lib/capture-debug'
import { mergeSelectorOverrides, type SelectorOverrideMap } from '../../lib/remote-selector-config'

// ---------------------------------------------------------------------------
// 诊断归档参考
// 以下 sendMessage / triggerSend / findSendControl 的实现经历过多次调试。
// 如果 DeepSeek 网页改版导致这些逻辑失效，可以参考归档的诊断脚本重新分析 DOM：
//   docs/research/diagnose-deepseek-send-button.js  — 定位发送按钮并分析 DOM 层级
//   docs/research/diagnose-deepseek-upload.js        — 诊断图片上传流程和输入框结构
// 诊断脚本需在浏览器 DevTools 中选中 DeepSeek iframe 上下文后运行。
// ---------------------------------------------------------------------------

const DEFAULT_INPUT_SELECTORS = [
  'textarea[placeholder*="Message" i]',
  'textarea[placeholder*="Send" i]',
  'textarea[placeholder*="发送"]',
  'textarea[placeholder*="输入"]',
  'textarea',
  '[contenteditable="true"]',
  '[role="textbox"]',
]

const DEFAULT_SEND_BUTTON_SELECTORS = [
  'button[aria-label*="Send" i]',
  'button[title*="Send" i]',
  'button[aria-label*="发送"]',
  'button[title*="发送"]',
  'button[type="submit"]',
  '[role="button"][aria-label*="Send" i]',
  '[role="button"][title*="Send" i]',
  '[role="button"][aria-label*="发送"]',
  '[role="button"][title*="发送"]',
  // DeepSeek 发送按钮使用 design-system 类（ds-button--primary ds-button--filled），无 aria-label/title
  '[role="button"].ds-button--primary.ds-button--filled',
  'button.ds-button--primary.ds-button--filled',
]

const DEFAULT_STOP_BUTTON_SELECTORS = [
  'button[aria-label*="停止"]',
  'button[title*="停止"]',
  'button[aria-label*="中止"]',
  'button[title*="中止"]',
  'button[aria-label*="stop" i]',
  'button[title*="stop" i]',
  'button[aria-label*="cancel" i]',
  'button[title*="cancel" i]',
  '[role="button"][aria-label*="停止"]',
  '[role="button"][title*="停止"]',
  '[role="button"][aria-label*="中止"]',
  '[role="button"][title*="中止"]',
  '[role="button"][aria-label*="stop" i]',
  '[role="button"][title*="stop" i]',
  '[role="button"][aria-label*="cancel" i]',
  '[role="button"][title*="cancel" i]',
  '[data-testid*="stop" i]',
  '[data-testid*="cancel" i]',
  '[class*="stop" i]',
  '[class*="cancel" i]',
]

const DEFAULT_RESPONSE_SELECTORS = [
  '[data-testid*="assistant" i]',
  '[data-testid*="answer" i]',
  '[data-testid*="message" i]',
  '[class*="assistant" i]',
  '[class*="answer" i]',
  '[class*="markdown" i]',
  '[class*="message" i]',
  '.markdown',
  'article',
  '[role="article"]',
]

const RESPONSE_EXCLUDE_ANCESTORS = [
  'aside',
  'nav',
  'header',
  'footer',
  'textarea',
  'input',
  'button',
  '[role="button"]',
  '[contenteditable="true"]',
].join(',')

interface DeepSeekSelectors {
  [key: string]: string[]
  inputBox: string[]
  sendButton: string[]
  stopButton: string[]
  response: string[]
}

const DEFAULT_SELECTORS: DeepSeekSelectors = {
  inputBox: DEFAULT_INPUT_SELECTORS,
  sendButton: DEFAULT_SEND_BUTTON_SELECTORS,
  stopButton: DEFAULT_STOP_BUTTON_SELECTORS,
  response: DEFAULT_RESPONSE_SELECTORS,
}

const PASTE_ATTACHMENT_EVIDENCE_TIMEOUT_MS = 700
const DROP_ATTACHMENT_EVIDENCE_TIMEOUT_MS = 2300
const ATTACHMENT_FAILURE_SETTLE_MS = 900
const ATTACHMENT_FAILURE_PATTERN = /异常文件|删除异常文件|未提取到文字|failed|error/i
const IMAGE_MODE_REQUIRED_ERROR = 'DeepSeek 仅识图模式支持图片，请新建或切换到识图模式后重试'

function queryFirst<T extends Element = Element>(selectors: string[]): T | null {
  for (const selector of selectors) {
    const el = document.querySelector<T>(selector)
    if (el) return el
  }
  return null
}

function findFileInput(): HTMLInputElement | null {
  const candidates = [
    "input[type='file'][accept*='image']",
    "input[type='file'][aria-label*='upload' i]",
    "input[type='file'][aria-label*='附件' i]",
    "input[type='file'][aria-label*='图片' i]",
    "input[type='file']",
  ]
  for (const selector of candidates) {
    const input = document.querySelector<HTMLInputElement>(selector)
    if (input) return input
  }
  return null
}

function attachmentDebugScope(scope: ParentNode): string {
  if (scope instanceof HTMLElement) {
    return [
      scope.tagName.toLowerCase(),
      scope.className ? `.${scope.className.toString().trim().replace(/\s+/g, '.')}` : '',
      scope.getAttribute('role') ? `[role="${scope.getAttribute('role')}"]` : '',
    ].join('')
  }
  return 'document'
}

function logUploadAttempt(route: string, file: File, details: Record<string, unknown>): void {
  logCaptureDebug({
    platform: 'deepseek',
    event: 'upload-attempt',
    route,
    fileName: file.name,
    fileType: file.type,
    fileSize: file.size,
    ...details,
  })
}

function bodyTextPreview(): string {
  return normalizeText(document.body.innerText || document.body.textContent || '').slice(0, 300)
}

function hasActiveVisionModeControl(): boolean {
  return [...document.querySelectorAll<HTMLElement>('button, [role="button"], [aria-selected], [aria-pressed], [aria-current]')]
    .some((el) => {
      const marker = [
        el.textContent ?? '',
        el.getAttribute('aria-label') ?? '',
        el.getAttribute('title') ?? '',
      ].join(' ')
      if (!/识图模式/.test(marker)) return false
      return el.getAttribute('aria-selected') === 'true'
        || el.getAttribute('aria-pressed') === 'true'
        || el.getAttribute('aria-current') === 'page'
        || /\b(active|selected|checked)\b/i.test(el.className?.toString() ?? '')
    })
}

type DeepSeekModeState = 'vision' | 'non-vision' | 'unknown'

function detectVisionModeState(): DeepSeekModeState {
  const text = bodyTextPreview()
  if (/使用识图模式开始对话|识图模式开始对话|当前.*识图模式/.test(text)) return 'vision'
  if (hasActiveVisionModeControl()) return 'vision'
  if (/快速模式下|快速模式|专家模式|不支持上传文件/.test(text)) return 'non-vision'
  return 'unknown'
}

function isDeepSeekVisionMode(): boolean {
  return detectVisionModeState() !== 'non-vision'
}

function assertCanSendImageInCurrentMode(): void {
  if (detectVisionModeState() !== 'non-vision') return
  logCaptureDebug({
    platform: 'deepseek',
    event: 'image-mode-check',
    ok: false,
    reason: 'vision-mode-required',
    pageTextPreview: bodyTextPreview(),
  })
  throw new Error(IMAGE_MODE_REQUIRED_ERROR)
}

async function attachFileToInput(file: File): Promise<boolean> {
  const input = findFileInput()
  if (!input) {
    logUploadAttempt('file-input', file, { ok: false, reason: 'file input not found' })
    return false
  }
  const scope = findAttachmentScope(input)
  const baseline = attachmentEvidenceCount(file, scope)
  const dt = buildDataTransferFromFile(file)
  try {
    input.files = dt.files
  } catch {
    Object.defineProperty(input, 'files', { value: dt.files, configurable: true })
  }
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  const ok = await waitForAttachmentEvidence(file, baseline, scope)
  const failure = ok ? await waitForAttachmentFailure(scope) : null
  logUploadAttempt('file-input', file, {
    ok: ok && !failure,
    scope: attachmentDebugScope(scope),
    baseline,
    evidence: attachmentEvidenceCount(file, scope),
    accept: input.accept,
    failureText: failure?.text,
    reason: failure ? 'abnormal-file' : undefined,
  })
  if (failure) throw new Error(`deepseek image upload rejected as abnormal file: ${failure.text}`)
  return ok
}

async function pasteFileIntoComposer(file: File, selectors: DeepSeekSelectors): Promise<boolean> {
  const box = queryFirst<HTMLElement>(selectors.inputBox)
  if (!box) {
    logUploadAttempt('paste-drop', file, { ok: false, reason: 'composer not found' })
    return false
  }
  const scope = findAttachmentScope(box)
  const baseline = attachmentEvidenceCount(file, scope)
  try {
    box.focus()
  } catch {
    /* focus may be blocked in embedded frames */
  }
  const dt = buildDataTransferFromFile(file)
  dispatchPaste(box, dt)
  const pasteOk = await waitForAttachmentEvidence(file, baseline, scope, PASTE_ATTACHMENT_EVIDENCE_TIMEOUT_MS)
  if (pasteOk) {
    const failure = await waitForAttachmentFailure(scope)
    logUploadAttempt('paste-drop', file, {
      ok: !failure,
      method: 'paste',
      scope: attachmentDebugScope(scope),
      baseline,
      evidence: attachmentEvidenceCount(file, scope),
      inputTag: box.tagName.toLowerCase(),
      inputPlaceholder: box.getAttribute('placeholder') ?? '',
      failureText: failure?.text,
      reason: failure ? 'abnormal-file' : undefined,
    })
    if (failure) throw new Error(`deepseek image upload rejected as abnormal file: ${failure.text}`)
    return true
  }

  const dropBaseline = attachmentEvidenceCount(file, scope)
  dispatchPaste(box, dt, 'drop')
  const ok = await waitForAttachmentEvidence(file, dropBaseline, scope, DROP_ATTACHMENT_EVIDENCE_TIMEOUT_MS)
  const failure = ok ? await waitForAttachmentFailure(scope) : null
  logUploadAttempt('paste-drop', file, {
    ok: ok && !failure,
    method: 'drop',
    scope: attachmentDebugScope(scope),
    baseline: dropBaseline,
    evidence: attachmentEvidenceCount(file, scope),
    inputTag: box.tagName.toLowerCase(),
    inputPlaceholder: box.getAttribute('placeholder') ?? '',
    failureText: failure?.text,
    reason: failure ? 'abnormal-file' : undefined,
  })
  if (failure) throw new Error(`deepseek image upload rejected as abnormal file: ${failure.text}`)
  return ok
}

function findAttachmentScope(anchor: HTMLElement): ParentNode {
  let best: HTMLElement | null = null
  let scope: HTMLElement | null = anchor
  for (let depth = 0; scope.parentElement && depth < 8; depth += 1) {
    scope = scope.parentElement
    if (scope === document.body || scope === document.documentElement) break
    if (scope.querySelector('textarea, [contenteditable="true"], [role="textbox"]') || scope.querySelector('input[type="file"]')) {
      best = scope
    }
  }
  return best ?? anchor.parentElement ?? document.body
}

function attachmentEvidenceCount(file: File, scope: ParentNode = document.body): number {
  const fileName = file.name.toLowerCase()
  const textHits = [...scope.querySelectorAll<HTMLElement>('*')]
    .filter((el) => {
      const text = (el.textContent ?? '').toLowerCase()
      const label = [
        el.getAttribute('alt') ?? '',
        el.getAttribute('title') ?? '',
        el.getAttribute('aria-label') ?? '',
      ].join(' ').toLowerCase()
      return text.includes(fileName) || label.includes(fileName)
    }).length
  const uploadMarks = scope.querySelectorAll([
    'img',
    'canvas',
    '[class*="upload" i]',
    '[class*="attach" i]',
    '[class*="file" i]',
    '[class*="image" i]',
    '[data-testid*="upload" i]',
    '[data-testid*="attach" i]',
    '[data-testid*="file" i]',
  ].join(',')).length
  return textHits + uploadMarks
}

async function waitForAttachmentEvidence(file: File, baseline: number, scope: ParentNode = document.body, maxMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (attachmentEvidenceCount(file, scope) > baseline) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

function attachmentFailureDetails(scope: ParentNode): { text: string } | null {
  const text = normalizeText(scope instanceof HTMLElement ? scope.innerText || scope.textContent || '' : document.body.innerText || document.body.textContent || '')
  const match = text.match(ATTACHMENT_FAILURE_PATTERN)
  if (!match) return null
  const start = Math.max(0, match.index ? match.index - 40 : 0)
  const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 60)
  return { text: text.slice(start, end) }
}

async function waitForAttachmentFailure(scope: ParentNode, maxMs = ATTACHMENT_FAILURE_SETTLE_MS): Promise<{ text: string } | null> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const failure = attachmentFailureDetails(scope)
    if (failure) return failure
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}

function writeNativeTextareaValue(el: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(el, text)
  el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
}

function writeEditableValue(el: HTMLElement, text: string): void {
  el.textContent = text
  el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
  el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))
}

function findSendControl(selectors: DeepSeekSelectors): HTMLElement | null {
  const direct = queryFirst<HTMLElement>(selectors.sendButton)
  if (direct) return direct

  // 使用全局选择器兜底（覆盖 DeepSeek 的 ds-button 类）
  for (const sel of DEFAULT_SEND_BUTTON_SELECTORS) {
    const el = document.querySelector<HTMLElement>(sel)
    if (el) return el
  }

  const controls = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
    .filter((button) => {
      const isDisabled = (button instanceof HTMLButtonElement && button.disabled)
        || button.getAttribute('aria-disabled') === 'true'
      return !isDisabled
    })
    .filter((button) => {
      const marker = [
        button.getAttribute('aria-label') ?? '',
        button.getAttribute('title') ?? '',
        button.className?.toString() ?? '',
      ].join(' ')
      return !/删除|remove|delete|close|clear|上传|upload|附件|attach/i.test(marker)
    })
  const textButton = controls.find((button) => /发送|send/i.test(button.textContent ?? ''))
  if (textButton) return textButton

  const input = queryFirst<HTMLElement>(selectors.inputBox)
  if (!input) return null
  let scope: HTMLElement | null = input.parentElement
  for (let depth = 0; scope && depth < 5; depth += 1, scope = scope.parentElement) {
    const scopedControls = [...scope.querySelectorAll<HTMLElement>('button, [role="button"]')]
      .filter((button) => {
        const isDisabled = (button instanceof HTMLButtonElement && button.disabled)
          || button.getAttribute('aria-disabled') === 'true'
        return !isDisabled
      })
      .filter((button) => {
        const marker = [
          button.getAttribute('aria-label') ?? '',
          button.getAttribute('title') ?? '',
          button.className?.toString() ?? '',
        ].join(' ')
        return !/删除|remove|delete|close|clear|上传|upload|附件|attach/i.test(marker)
      })
    if (scopedControls.length > 0) {
      const primaryBtn = scopedControls.find((btn) =>
        btn.classList.contains('ds-button--primary') && btn.classList.contains('ds-button--filled')
      )
      if (primaryBtn) return primaryBtn
      return scopedControls[scopedControls.length - 1]
    }
  }
  return null
}

function hasStopGeneratingButton(selectors: DeepSeekSelectors): boolean {
  if (queryFirst<HTMLElement>(selectors.stopButton)) return true
  return [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
    .some((button) => {
      const marker = [
        button.getAttribute('aria-label') ?? '',
        button.getAttribute('title') ?? '',
        button.getAttribute('data-testid') ?? '',
        button.className?.toString() ?? '',
        button.textContent ?? '',
      ].join(' ')
      return /停止|中止|取消|stop|cancel/i.test(marker)
    })
}

function hasPendingContent(selectors: DeepSeekSelectors): boolean {
  const box = queryFirst<HTMLElement>(selectors.inputBox)
  if (!box) return false
  const text = (box as HTMLTextAreaElement).value?.trim() ?? ''
  return text.length > 0
}

async function waitForSendAccepted(selectors: DeepSeekSelectors, maxMs = 700): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (hasStopGeneratingButton(selectors) || !hasPendingContent(selectors)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return hasStopGeneratingButton(selectors) || !hasPendingContent(selectors)
}

function activateControl(button: HTMLElement): void {
  const mouseInit: MouseEventInit = { bubbles: true, cancelable: true, composed: true }
  button.dispatchEvent(new MouseEvent('mousedown', mouseInit))
  button.dispatchEvent(new MouseEvent('mouseup', mouseInit))
  button.click()
}

function dispatchEnter(el: HTMLElement): void {
  const init: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    composed: true,
  }
  // 触发完整的键盘事件序列，确保 React 等框架能正确响应
  el.dispatchEvent(new KeyboardEvent('keydown', init))
  el.dispatchEvent(new KeyboardEvent('keypress', init))
  el.dispatchEvent(new KeyboardEvent('keyup', init))
}

function normalizeText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

const VISION_MODE_BUTTON_SELECTORS = 'button, [role="button"], [role="tab"], [role="radio"]'
const VISION_MODE_TEXT_RE = /^(识图模式)+$/

function findVisionModeButton(): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(VISION_MODE_BUTTON_SELECTORS)
  for (const el of candidates) {
    if (el.hidden) continue
    if (el.getAttribute('aria-hidden') === 'true') continue
    if (el instanceof HTMLButtonElement && el.disabled) continue
    if (el.getAttribute('aria-disabled') === 'true') continue

    const text = normalizeText(el.textContent ?? '')
    const label = normalizeText(el.getAttribute('aria-label') ?? '')
    const title = normalizeText(el.getAttribute('title') ?? '')

    // DeepSeek 的 radio 按钮内部有一个可见 label 和一个 aria-hidden 副本，
    // 导致 textContent 可能是 "识图模式\n识图模式"（含换行）。
    // 去掉所有空白后用正则匹配重复的文字。
    const stripped = text.replace(/\s+/g, '')
    if (!VISION_MODE_TEXT_RE.test(stripped) && label !== '识图模式' && title !== '识图模式') continue

    try {
      const style = window.getComputedStyle?.(el)
      if (style && (style.display === 'none' || style.visibility === 'hidden')) continue
    } catch {
      /* getComputedStyle may fail in some environments; assume visible */
    }

    return el
  }
  return null
}

async function waitForVisionModeButton(maxMs: number): Promise<HTMLElement | null> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const button = findVisionModeButton()
    if (button) return button
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return null
}

async function waitForVisionEvidence(maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (detectVisionModeState() === 'vision') return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

export async function ensureDeepSeekVisionMode(): Promise<boolean> {
  try {
    const initialState = detectVisionModeState()
    if (initialState === 'vision') {
      logCaptureDebug({
        platform: 'deepseek',
        event: 'vision-switch',
        reason: 'already-vision',
      })
      return true
    }

    const button = await waitForVisionModeButton(8000)
    if (!button) {
      logCaptureDebug({
        platform: 'deepseek',
        event: 'vision-switch',
        reason: initialState === 'non-vision' ? 'button-not-found' : 'button-not-found',
        initialState,
      })
      return false
    }

    const isDisabled = (button instanceof HTMLButtonElement && button.disabled)
      || button.getAttribute('aria-disabled') === 'true'
    if (isDisabled) {
      logCaptureDebug({
        platform: 'deepseek',
        event: 'vision-switch',
        reason: 'button-disabled',
      })
      return false
    }

    activateControl(button)

    const switched = await waitForVisionEvidence(3000)
    logCaptureDebug({
      platform: 'deepseek',
      event: 'vision-switch',
      reason: switched ? 'switched' : 'verification-timeout',
    })
    return switched
  } catch (err) {
    logCaptureDebug({
      platform: 'deepseek',
      event: 'vision-switch',
      reason: 'exception',
      error: String(err),
    })
    return false
  }
}

function cleanDeepSeekResponseText(text: string): string {
  const withoutReferenceLines = normalizeText(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !/^已阅读\s*\d+\s*个网页$/.test(line))
    .filter((line) => !/^\d+\s*个网页$/.test(line))
    .join('\n')

  return normalizeText(withoutReferenceLines)
    .replace(/^已阅读\s*\d+\s*个网页\s*/u, '')
    .replace(/\s*\d+\s*个网页$/u, '')
    .replace(/(?<=[\p{L}])-\d+\b/gu, '')
    .replace(/(^|\s)-\d+(?=\s|$)/g, ' ')
    .trim()
}

function isHidden(el: HTMLElement): boolean {
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true
  const style = window.getComputedStyle?.(el)
  return style?.display === 'none' || style?.visibility === 'hidden'
}

function isUserMessage(el: HTMLElement): boolean {
  const marker = [
    el.getAttribute('data-testid') ?? '',
    el.getAttribute('data-role') ?? '',
    el.className?.toString() ?? '',
    el.getAttribute('aria-label') ?? '',
  ].join(' ')
  if (/\b(_9663006|d29f3d7d)\b/.test(marker)) return true
  return /\b(user|human|question|query)\b/i.test(marker) && !/\b(assistant|answer)\b/i.test(marker)
}

function elementMarker(el: HTMLElement): string {
  return [
    el.getAttribute('data-testid') ?? '',
    el.getAttribute('data-role') ?? '',
    el.className?.toString() ?? '',
    el.getAttribute('aria-label') ?? '',
  ].join(' ')
}

function isResponseActionBar(el: HTMLElement): boolean {
  const marker = elementMarker(el)
  if (/\b(action|toolbar|operate|feedback|copy|regenerate)\b/i.test(marker)) return true
  const buttonText = normalizeText(el.textContent ?? '')
  return /复制|重新生成|点赞|点踩|分享|copy|regenerate/i.test(buttonText)
}

function hasDirectResponseActions(el: HTMLElement): boolean {
  return [...el.children].some((child) => child instanceof HTMLElement && isResponseActionBar(child))
}

function responseCandidateScore(el: HTMLElement, text: string): number {
  const marker = elementMarker(el)
  let score = 0
  const isFragment = el.matches('p, li')
  if ((/\b(assistant|answer|markdown)\b/i.test(marker) || el.matches('article, [role="article"]')) && !isFragment) score += 100
  if (/\b(user|human|question|query|recommend|suggest|guide|prompt|chip|card)\b/i.test(marker)) score -= 100
  if (/^(已阅读\s*\d+\s*个网页|\d+\s*个网页)$/.test(text)) score -= 200
  if (hasDirectResponseActions(el)) score += 120
  if (/^[^\n]{1,80}[?？]$/.test(text)) score -= 80
  if (text.length <= 80 && !hasDirectResponseActions(el)) score -= 20
  if (el.closest('main')) score += 10
  score += Math.min(text.length, 1000) / 100
  return score
}

function hasOtherResponseCandidate(root: HTMLElement, current: HTMLElement, responseSelector: string): boolean {
  return [...root.querySelectorAll<HTMLElement>(responseSelector)]
    .some((candidate) => {
      if (candidate === current || current.contains(candidate) || candidate.contains(current)) return false
      if (isHidden(candidate) || candidate.closest(RESPONSE_EXCLUDE_ANCESTORS) || isUserMessage(candidate)) return false
      return elementToMarkdownText(candidate).length > 0
    })
}

function canUseExpandedResponseRoot(el: HTMLElement, text: string, current: HTMLElement, responseSelector: string): boolean {
  if (isHidden(el) || el.closest(RESPONSE_EXCLUDE_ANCESTORS) || isUserMessage(el)) return false
  if ([...el.querySelectorAll<HTMLElement>('*')].some(isUserMessage)) return false
  if (el.querySelector('textarea, input, [contenteditable="true"], [role="textbox"]')) return false
  if (hasOtherResponseCandidate(el, current, responseSelector) && !hasDirectResponseActions(el)) return false
  const expandedText = elementToMarkdownText(el)
  if (expandedText.length < text.length) return false
  return expandedText.includes(text)
}

function expandResponseCandidate(el: HTMLElement, text: string, responseSelector: string): { el: HTMLElement; text: string } {
  let bestEl = el
  let bestText = text
  let parent = el.parentElement
  for (let depth = 0; parent && depth < 8; depth += 1, parent = parent.parentElement) {
    if (!canUseExpandedResponseRoot(parent, bestText, el, responseSelector)) break
    bestEl = parent
    bestText = elementToMarkdownText(parent)
  }
  return { el: bestEl, text: bestText }
}

function getLatestResponseText(selectors: DeepSeekSelectors): string {
  // DeepSeek 的混淆 class 会变化；改候选选择前先看 docs/RESPONSE_CAPTURE_MAINTENANCE.md。
  const seen = new Set<string>()
  const responseSelector = selectors.response.join(',')
  const candidates = [...document.querySelectorAll<HTMLElement>(responseSelector)]
    .filter((el) => !isHidden(el))
    .filter((el) => !el.closest(RESPONSE_EXCLUDE_ANCESTORS))
    .filter((el) => !isUserMessage(el))
    .map((el, index) => {
      const text = elementToMarkdownText(el)
      const expanded = expandResponseCandidate(el, text, responseSelector)
      return {
        el: expanded.el,
        text: cleanDeepSeekResponseText(expanded.text),
        score: responseCandidateScore(expanded.el, expanded.text),
        index,
      }
    })
    .filter((candidate) => candidate.text.length > 0)
    .filter((candidate) => {
      if (seen.has(candidate.text)) return false
      seen.add(candidate.text)
      return true
    })
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      return a.index - b.index
    })

  logCaptureDebug({
    platform: 'deepseek',
    event: 'candidates',
    candidates: candidates.map((candidate) => ({
      ...describeCaptureElement(candidate.el, candidate.text),
      index: candidate.index,
      score: candidate.score,
      isUserMessage: false,
    })),
    selected: candidates.length > 0
      ? {
          ...describeCaptureElement(candidates[candidates.length - 1].el, candidates[candidates.length - 1].text),
          index: candidates[candidates.length - 1].index,
          score: candidates[candidates.length - 1].score,
          isUserMessage: false,
        }
      : undefined,
  })

  return candidates[candidates.length - 1]?.text ?? ''
}

export function createDeepSeekAdapter(selectorOverrides?: SelectorOverrideMap): AIAdapter {
  const selectors = mergeSelectorOverrides(DEFAULT_SELECTORS, selectorOverrides) as DeepSeekSelectors
  let lastEventHandler: ((e: StreamEvent) => void) | null = null

  return {
    async isLoggedIn() {
      return !!queryFirst(selectors.inputBox)
    },

    async writeText(text: string) {
      const box = queryFirst<HTMLElement>(selectors.inputBox)
      if (!box) throw new Error('deepseek input box not found')
      if (box instanceof HTMLTextAreaElement) {
        writeNativeTextareaValue(box, text)
      } else {
        writeEditableValue(box, text)
      }
    },

    async triggerSend() {
      const box = queryFirst<HTMLElement>(selectors.inputBox)
      if (box) {
        box.focus()
        await new Promise((resolve) => setTimeout(resolve, 50))
        // 尝试 Enter 键发送（参考 Gemini 的 waitForSendAccepted 检测）
        for (let attempt = 0; attempt < 3; attempt += 1) {
          dispatchEnter(box)
          if (await waitForSendAccepted(selectors)) return
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        // Enter 方案失败，回退到按钮点击
      }

      const btn = findSendControl(selectors)
      if (btn) {
        activateControl(btn)
        return
      }
      throw new Error('deepseek send button not found')
    },

    async sendMessage(text: string, image?: File) {
      if (image) assertCanSendImageInCurrentMode()
      await this.writeText(text)
      await new Promise((resolve) => setTimeout(resolve, 80))
      if (image) await this.attachImage(image)
      // DeepSeek 的 paste 上传是异步的：先创建预览，再实际上传文件。
      // 需要足够等待让文件上传完成，否则发送时只发文字不发图片。
      await new Promise((resolve) => setTimeout(resolve, image ? 3000 : 200))
      await this.triggerSend()
    },

    async attachImage(file: File) {
      if (await pasteFileIntoComposer(file, selectors)) return
      if (await attachFileToInput(file)) return
      throw new Error('deepseek image upload failed')
    },

    async getLastResponse() {
      return getLatestResponseText(selectors)
    },

    async getConversationState(): Promise<ConversationState> {
      if (!queryFirst(selectors.inputBox)) return { status: 'error', errorMessage: 'DeepSeek 输入框未识别' }
      const lastResponse = getLatestResponseText(selectors)
      if (hasStopGeneratingButton(selectors)) return { status: 'streaming', lastResponse }
      if (lastResponse) return { status: 'finished', lastResponse }
      return { status: 'idle' }
    },

    onStreamEvent(handler) {
      lastEventHandler = handler
      return () => {
        lastEventHandler = null
      }
    },

    async detectRateLimit() {
      return false
    },
  }
}
