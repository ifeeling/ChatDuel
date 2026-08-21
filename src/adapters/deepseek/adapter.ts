import type { AIAdapter, AdapterDiagnostics, AdapterSendInternals } from '../base'
import { emitDiagnostic } from '../shared/diagnostics'
import { findFileInput } from '../shared/file-input'
import { writeEditableValue, waitForSendAccepted } from '../shared/dom-write'
import {
  queryFirst,
  writeNativeTextareaValue,
  activateControl,
  normalizeText,
  isHidden,
  elementMarker,
  hasDirectResponseActions,
  hasStopGeneratingButton,
  isUserMessage,
  dispatchEnter,
  hasPendingContent,
} from '../shared/ds-doubao-shared'
import type { ConversationState } from '../../types'
import { buildDataTransferFromFile, dispatchPaste } from '../../lib/image-handler'
import { cloneWithoutThinking, elementToMarkdownText } from '../../lib/dom-response-text'
import { describeCaptureElement, logCaptureDebug, textPreview } from '../../lib/capture-debug'
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
  // DeepSeek 专属：更精确匹配 assistant 消息容器
  'div.ds-markdown',
  '[class*="ds-markdown" i]',
  // 通用选择器
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
export const DEEPSEEK_SELECTOR_VERSION = 'builtin-1'

// DeepSeek 混淆 class 上的用户消息标记（提取自原私有 isUserMessage 副本）。
const DEEPSEEK_USER_MESSAGE_CLASS = /\b(_9663006|d29f3d7d)\b/

// 绑定 DeepSeek 专属 class 标记的 isUserMessage 封装，避免四处重复传参。
const isDeepSeekUserMessage = (el: HTMLElement): boolean =>
  isUserMessage(el, { extraClassPattern: DEEPSEEK_USER_MESSAGE_CLASS })

const PASTE_ATTACHMENT_EVIDENCE_TIMEOUT_MS = 700
const DROP_ATTACHMENT_EVIDENCE_TIMEOUT_MS = 2300
const ATTACHMENT_FAILURE_SETTLE_MS = 900
const ATTACHMENT_FAILURE_PATTERN = /异常文件|删除异常文件|未提取到文字|failed|error/i
const ATTACHMENT_EVIDENCE_SELECTOR = [
  'img',
  'canvas',
  '[class*="upload" i]',
  '[class*="attach" i]',
  '[class*="file" i]',
  '[class*="image" i]',
  '[data-testid*="upload" i]',
  '[data-testid*="attach" i]',
  '[data-testid*="file" i]',
].join(',')
const ATTACHMENT_FAILURE_CONTEXT_SELECTOR = [
  ATTACHMENT_EVIDENCE_SELECTOR,
  '[role="alert"]',
  '[aria-live="assertive"]',
].join(',')
const IMAGE_MODE_REQUIRED_ERROR = 'DeepSeek 仅识图模式支持图片，请新建或切换到识图模式后重试'

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

// DeepSeek 原版 findFileInput 用的选择器子集（不含 data-testid='upload' / aria-label*='image'，
// 且不递归子 frame）。抽取到共享原语后，显式传回原版行为，避免无意的行为扩张。
const DEEPSEEK_FILE_INPUT_CANDIDATES = [
  "input[type='file'][accept*='image']",
  "input[type='file'][aria-label*='upload' i]",
  "input[type='file'][aria-label*='附件' i]",
  "input[type='file'][aria-label*='图片' i]",
  "input[type='file']",
]

async function attachFileToInput(file: File): Promise<boolean> {
  const input = findFileInput({ candidates: DEEPSEEK_FILE_INPUT_CANDIDATES, recurseIframes: false })
  if (!input) {
    logUploadAttempt('file-input', file, { ok: false, reason: 'file input not found' })
    return false
  }
  const scope = findAttachmentScope(input)
  const baseline = attachmentEvidenceCount(file, scope)
  const failureBaseline = attachmentFailureSnapshot(file, scope)
  const dt = buildDataTransferFromFile(file)
  try {
    input.files = dt.files
  } catch {
    Object.defineProperty(input, 'files', { value: dt.files, configurable: true })
  }
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  const ok = await waitForAttachmentEvidence(file, baseline, scope)
  const failure = ok ? await waitForAttachmentFailure(file, scope, failureBaseline) : null
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
  const failureBaseline = attachmentFailureSnapshot(file, scope)
  try {
    box.focus()
  } catch {
    /* focus may be blocked in embedded frames */
  }
  const dt = buildDataTransferFromFile(file)
  dispatchPaste(box, dt)
  const pasteOk = await waitForAttachmentEvidence(file, baseline, scope, PASTE_ATTACHMENT_EVIDENCE_TIMEOUT_MS)
  if (pasteOk) {
    const failure = await waitForAttachmentFailure(file, scope, failureBaseline)
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
  const failure = ok ? await waitForAttachmentFailure(file, scope, failureBaseline) : null
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
  const uploadMarks = scope.querySelectorAll(ATTACHMENT_EVIDENCE_SELECTOR).length
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

function attachmentElementMarker(element: Element): string {
  return [
    element.textContent ?? '',
    element.getAttribute('alt') ?? '',
    element.getAttribute('title') ?? '',
    element.getAttribute('aria-label') ?? '',
  ].join(' ').toLowerCase()
}

function containsComposerInput(element: HTMLElement): boolean {
  return element.matches('textarea, [contenteditable="true"], [role="textbox"]')
    || !!element.querySelector('textarea, [contenteditable="true"], [role="textbox"]')
}

function attachmentFailureContexts(file: File, scope: ParentNode): HTMLElement[] {
  const fileName = file.name.toLowerCase()
  const seeds = [...scope.querySelectorAll<HTMLElement>(ATTACHMENT_FAILURE_CONTEXT_SELECTOR)]
  for (const element of scope.querySelectorAll<HTMLElement>('*')) {
    if (!attachmentElementMarker(element).includes(fileName)) continue
    const childMentionsFile = [...element.children]
      .some((child) => attachmentElementMarker(child).includes(fileName))
    if (!childMentionsFile) seeds.push(element)
  }

  const contexts = new Set<HTMLElement>()
  for (const seed of seeds) {
    contexts.add(seed)
    if (seed.parentElement && seed.parentElement !== scope && !containsComposerInput(seed.parentElement)) {
      contexts.add(seed.parentElement)
    }
  }
  return [...contexts]
}

type AttachmentFailureSnapshot = Map<HTMLElement, string>

function attachmentFailureSnapshot(file: File, scope: ParentNode): AttachmentFailureSnapshot {
  return new Map(attachmentFailureContexts(file, scope).map((element) => [
    element,
    normalizeText(element.innerText || element.textContent || ''),
  ]))
}

function attachmentFailureDetails(file: File, scope: ParentNode, baseline: AttachmentFailureSnapshot): { text: string } | null {
  for (const element of attachmentFailureContexts(file, scope)) {
    const text = normalizeText(element.innerText || element.textContent || '')
    if (baseline.get(element) === text) continue
    const match = text.match(ATTACHMENT_FAILURE_PATTERN)
    if (!match) continue
    const start = Math.max(0, match.index ? match.index - 40 : 0)
    const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 60)
    return { text: text.slice(start, end) }
  }
  return null
}

async function waitForAttachmentFailure(file: File, scope: ParentNode, baseline: AttachmentFailureSnapshot, maxMs = ATTACHMENT_FAILURE_SETTLE_MS): Promise<{ text: string } | null> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const failure = attachmentFailureDetails(file, scope, baseline)
    if (failure) return failure
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
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

// 「发送已被接受」判定：出现停止生成按钮，或输入框已清空（无待发内容）。
// 供 triggerSend / sendMessage 的轮询与最终检查复用，避免两处写法漂移。
function isSendAccepted(selectors: DeepSeekSelectors): boolean {
  return hasStopGeneratingButton(selectors) || !hasPendingContent(selectors, false)
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

// DeepSeek "深度思考" 会把思考链和正式回复分两个容器渲染
// （ai-arena content-shared.js 的踩坑记录里也提到这一点），但也可能出现思考内容和
// 正式回答同处一个容器、只靠一个可折叠触发文案分隔的情况。在拍平成文字之前先 clone
// 并按 DOM 边界删掉思考折叠区，而不是等拍平成一整段文字后再按行猜哪行是垃圾。
function rawResponseText(el: HTMLElement): string {
  return elementToMarkdownText(cloneWithoutThinking(el))
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

function responseCandidateScore(el: HTMLElement, text: string): number {
  const marker = elementMarker(el)
  let score = 0
  const isFragment = el.matches('p, li')
  if ((/\b(assistant|answer|markdown)\b/i.test(marker) || el.matches('article, [role="article"]')) && !isFragment) score += 100
  if (/\b(user|human|question|query|recommend|suggest|guide|prompt|chip|card|search|reference|citation|source)\b/i.test(marker)) score -= 100
  if (/^(已阅读\s*\d+\s*个网页|\d+\s*个网页)$/.test(text)) score -= 200
  if (hasDirectResponseActions(el)) score += 120
  if (/^[^\n]{1,80}[?？]$/.test(text)) score -= 80
  if (text.length <= 80 && !hasDirectResponseActions(el)) score -= 20
  if (el.closest('main')) score += 10
  score += Math.min(text.length, 1000) / 100
  return score
}

function responseCandidateVisualBottom(el: HTMLElement): number | null {
  const rect = el.getBoundingClientRect()
  if (!Number.isFinite(rect.bottom)) return null
  if (rect.width <= 0 && rect.height <= 0) return null
  return rect.bottom
}

function hasOtherResponseCandidate(root: HTMLElement, current: HTMLElement, responseSelector: string): boolean {
  return [...root.querySelectorAll<HTMLElement>(responseSelector)]
    .some((candidate) => {
      if (candidate === current || current.contains(candidate) || candidate.contains(current)) return false
      if (isHidden(candidate) || candidate.closest(RESPONSE_EXCLUDE_ANCESTORS) || isDeepSeekUserMessage(candidate)) return false
      return rawResponseText(candidate).length > 0
    })
}

function canUseExpandedResponseRoot(el: HTMLElement, text: string, current: HTMLElement, responseSelector: string): boolean {
  if (isHidden(el) || el.closest(RESPONSE_EXCLUDE_ANCESTORS) || isDeepSeekUserMessage(el)) return false
  if ([...el.querySelectorAll<HTMLElement>('*')].some((child) => isDeepSeekUserMessage(child))) return false
  if (el.querySelector('textarea, input, [contenteditable="true"], [role="textbox"]')) return false
  if (hasOtherResponseCandidate(el, current, responseSelector) && !hasDirectResponseActions(el)) return false
  const expandedText = rawResponseText(el)
  if (expandedText.length < text.length) return false
  if (!expandedText.includes(text)) return false
  // ds-markdown 是 DeepSeek 实际使用的完整回答渲染容器 class。
  // 如果当前元素有 ds-markdown 标记，说明它本身就是完整的回答容器，
  // 向上扩展会导致丢失标记、评分骤降。
  // 仅在父元素也有 ds-markdown 标记或有操作按钮时才允许扩展；
  // 测试中的 "markdown" / "answer" / "ds-markdown-paragraph" 等不受影响。
  if (current.classList.contains('ds-markdown')) {
    if (!el.classList.contains('ds-markdown') && !hasDirectResponseActions(el)) return false
  }
  return true
}

function expandResponseCandidate(el: HTMLElement, text: string, responseSelector: string): { el: HTMLElement; text: string } {
  let bestEl = el
  let bestText = text
  let parent = el.parentElement
  for (let depth = 0; parent && depth < 8; depth += 1, parent = parent.parentElement) {
    if (!canUseExpandedResponseRoot(parent, bestText, el, responseSelector)) break
    bestEl = parent
    bestText = rawResponseText(parent)
  }
  return { el: bestEl, text: bestText }
}

// 兜底提取：当常规选择器全部未命中时，从 <main> 中扫描响应文本。
// DeepSeek 的页面结构可能因版本更新而变化，此兜底确保即使在选择器失效时也能提取到内容。
function getMainFallbackText(): string {
  const main = document.querySelector('main')
  if (!main) return ''

  // 在 main 中找最后一个非用户消息、非隐藏、有实质内容的可见元素
  const candidates = [...main.querySelectorAll<HTMLElement>('div, p')]
    .filter((el) => !isHidden(el))
    .filter((el) => !isDeepSeekUserMessage(el))
    .filter((el) => !el.closest(RESPONSE_EXCLUDE_ANCESTORS))

  for (let i = candidates.length - 1; i >= 0; i--) {
    const text = cleanDeepSeekResponseText(rawResponseText(candidates[i]))
    if (text.length > 50) return text
  }

  return ''
}

function getLatestResponseText(selectors: DeepSeekSelectors): string {
  // DeepSeek 的混淆 class 会变化；改候选选择前先看 docs/RESPONSE_CAPTURE_MAINTENANCE.md。
  const seen = new Set<string>()
  const responseSelector = selectors.response.join(',')
  const candidates = [...document.querySelectorAll<HTMLElement>(responseSelector)]
    .filter((el) => !isHidden(el))
    .filter((el) => !el.closest(RESPONSE_EXCLUDE_ANCESTORS))
    .filter((el) => !isDeepSeekUserMessage(el))
    .map((el, index) => {
      const text = rawResponseText(el)
      const expanded = expandResponseCandidate(el, text, responseSelector)
      return {
        el: expanded.el,
        text: cleanDeepSeekResponseText(expanded.text),
        score: responseCandidateScore(expanded.el, expanded.text),
        index,
        isFragment: expanded.el.matches('p, li'),
        visualBottom: responseCandidateVisualBottom(expanded.el),
      }
    })
    .filter((candidate) => candidate.text.length > 0)
    .filter((candidate) => {
      if (seen.has(candidate.text)) return false
      seen.add(candidate.text)
      return true
    })

  // DeepSeek 的对话 DOM 可能按倒序排列，不能只依赖 DOM 顺序判断最新回答。
  // 页面提供有效布局位置时，优先选择视觉上最靠下的完整回答。
  const visuallyOrdered = candidates
    .filter((candidate) =>
      !candidate.isFragment
      && candidate.score >= 0
      && candidate.text.length >= 30
      && candidate.visualBottom !== null
    )
    .sort((a, b) => (a.visualBottom ?? 0) - (b.visualBottom ?? 0))
  const hasDistinctVisualOrder = visuallyOrdered.length >= 2
    && visuallyOrdered[0].visualBottom !== visuallyOrdered[visuallyOrdered.length - 1].visualBottom

  const HIGH_QUALITY_MIN_SCORE = 50
  const highQuality = candidates.filter((c) => c.score >= HIGH_QUALITY_MIN_SCORE)
  let selected = hasDistinctVisualOrder
    ? visuallyOrdered[visuallyOrdered.length - 1]
    : highQuality.length > 0
      ? highQuality.sort((a, b) => a.index - b.index)[highQuality.length - 1]
      : undefined

  if (!selected) {
    // 无高分候选时回退到原逻辑：按 score 排序取最高
    candidates.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score
      return a.index - b.index
    })
    selected = candidates[candidates.length - 1]
  }

  logCaptureDebug({
    platform: 'deepseek',
    event: 'candidates',
    candidates: candidates.map((candidate) => ({
      ...describeCaptureElement(candidate.el, candidate.text),
      index: candidate.index,
      score: candidate.score,
      isUserMessage: false,
    })),
    selected: selected
      ? {
          ...describeCaptureElement(selected.el, selected.text),
          index: selected.index,
          score: selected.score,
          isUserMessage: false,
        }
      : undefined,
  })

  return selected?.text ?? ''
}

// 获取响应文本，包含 main 兜底逻辑
function getResponseTextWithFallback(selectors: DeepSeekSelectors): string {
  const text = getLatestResponseText(selectors)
  logCaptureDebug({
    platform: 'deepseek',
    event: 'response-text-attempt',
    selectorHit: !!text,
    textLength: text?.length ?? 0,
    textPreview: textPreview(text ?? ''),
  })
  if (text) return text

  // 常规选择器未命中，尝试从 main 元素兜底提取
  const fallback = getMainFallbackText()
  if (fallback) {
    logCaptureDebug({
      platform: 'deepseek',
      event: 'response-fallback',
      textLength: fallback.length,
      textPreview: fallback.slice(0, 120),
    })
  } else {
    logCaptureDebug({
      platform: 'deepseek',
      event: 'response-fallback-empty',
      reason: 'no candidates in <main>',
    })
  }
  return fallback
}

export function createDeepSeekAdapter(selectorOverrides?: SelectorOverrideMap): AIAdapter & AdapterSendInternals {
  const selectors = mergeSelectorOverrides(DEFAULT_SELECTORS, selectorOverrides) as DeepSeekSelectors

  return {
    async writeText(text: string) {
      const box = queryFirst<HTMLElement>(selectors.inputBox)
      if (!box) throw new Error('deepseek input box not found')
      if (box instanceof HTMLTextAreaElement) {
        writeNativeTextareaValue(box, text)
      } else {
        writeEditableValue(box, text, 'beforeinput-then-input')
      }
    },

    async triggerSend() {
      const box = queryFirst<HTMLElement>(selectors.inputBox)
      if (box) {
        box.focus()
        await new Promise((resolve) => setTimeout(resolve, 50))
        // 尝试 Enter 键发送（参考 Gemini 的 waitForSendAccepted 检测）
        for (let attempt = 0; attempt < 3; attempt += 1) {
          dispatchEnter(box, 'keydown-keypress-keyup')
          if (await waitForSendAccepted(() => isSendAccepted(selectors))) return
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

    async sendMessage(text: string, image?: File, diagnostics?: AdapterDiagnostics) {
      if (image) {
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'attachment-prepare', stage: 'preparing', eventStatus: 'observed', hasAttachment: true,
        })
        try {
          assertCanSendImageInCurrentMode()
        } catch {
          emitDiagnostic(diagnostics, {
            component: 'platform-adapter', operation: 'attachment-prepare', stage: 'failed', eventStatus: 'failed',
            runOutcome: 'failed', errorCode: 'adapter-unsupported-page', hasAttachment: true,
          })
          throw new Error(IMAGE_MODE_REQUIRED_ERROR)
        }
      }
      const box = queryFirst<HTMLElement>(selectors.inputBox)
      if (!box) {
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'input-locate', stage: 'failed', eventStatus: 'failed',
          runOutcome: 'failed', errorCode: 'input-box-not-found', inputCharacterCount: text.length,
        })
        throw new Error('deepseek input box not found')
      }
      emitDiagnostic(diagnostics, {
        component: 'platform-adapter', operation: 'input-locate', stage: 'located', eventStatus: 'succeeded', inputCharacterCount: text.length,
      })
      try {
        if (box instanceof HTMLTextAreaElement) writeNativeTextareaValue(box, text)
        else writeEditableValue(box, text, 'beforeinput-then-input')
      } catch {
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'input-write', stage: 'failed', eventStatus: 'failed',
          runOutcome: 'failed', errorCode: 'input-write-failed', inputCharacterCount: text.length,
        })
        throw new Error('input write failed')
      }
      emitDiagnostic(diagnostics, {
        component: 'platform-adapter', operation: 'input-write', stage: 'written', eventStatus: 'succeeded', inputCharacterCount: text.length,
      })
      await new Promise((resolve) => setTimeout(resolve, 80))
      if (image) {
        try {
          await this.attachImage(image)
        } catch {
          emitDiagnostic(diagnostics, {
            component: 'platform-adapter', operation: 'attachment-prepare', stage: 'failed', eventStatus: 'failed',
            runOutcome: 'failed', errorCode: 'attachment-preparation-timeout', hasAttachment: true,
          })
          throw new Error('deepseek image upload failed')
        }
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'attachment-prepare', stage: 'prepared', eventStatus: 'succeeded', hasAttachment: true,
        })
      } else {
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'attachment-prepare', stage: 'skipped', eventStatus: 'skipped', hasAttachment: false,
        })
      }
      // DeepSeek 的 paste 上传是异步的：先创建预览，再实际上传文件。
      // 需要足够等待让文件上传完成，否则发送时只发文字不发图片。
      await new Promise((resolve) => setTimeout(resolve, image ? 3000 : 200))
      const currentBox = queryFirst<HTMLElement>(selectors.inputBox)
      if (!currentBox) {
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'input-locate', stage: 'failed', eventStatus: 'failed',
          runOutcome: 'failed', errorCode: 'input-box-not-found', inputCharacterCount: text.length,
        })
        throw new Error('deepseek input box not found')
      }
      const currentText = currentBox instanceof HTMLTextAreaElement
        ? currentBox.value
        : currentBox.textContent ?? ''
      if (currentText !== text) {
        if (currentBox instanceof HTMLTextAreaElement) writeNativeTextareaValue(currentBox, text)
        else writeEditableValue(currentBox, text, 'beforeinput-then-input')
      }
      currentBox.focus()
      await new Promise((resolve) => setTimeout(resolve, 50))
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        dispatchEnter(currentBox, 'keydown-keypress-keyup')
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'send-click', stage: 'clicked', eventStatus: 'succeeded', retryNumber: attempt,
        })
        if (await waitForSendAccepted(() => isSendAccepted(selectors))) {
          emitDiagnostic(diagnostics, {
            component: 'platform-adapter', operation: 'send-ack', stage: 'accepted', eventStatus: 'succeeded',
            retryNumber: attempt, retryCount: attempt,
          })
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      const btn = findSendControl(selectors)
      if (btn) {
        activateControl(btn)
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'send-click', stage: 'clicked', eventStatus: 'succeeded', retryNumber: 4,
        })
        if (isSendAccepted(selectors)) {
          emitDiagnostic(diagnostics, {
            component: 'platform-adapter', operation: 'send-ack', stage: 'accepted', eventStatus: 'succeeded', retryNumber: 4, retryCount: 4,
          })
        } else {
          emitDiagnostic(diagnostics, {
            component: 'platform-adapter', operation: 'send-ack', stage: 'waiting', eventStatus: 'observed', retryNumber: 4, retryCount: 4,
          })
        }
        return
      }
      emitDiagnostic(diagnostics, {
        component: 'platform-adapter', operation: 'send-click', stage: 'failed', eventStatus: 'failed',
        runOutcome: 'failed', errorCode: 'send-button-not-found', retryCount: 3,
      })
      throw new Error('deepseek send button not found')
    },

    async attachImage(file: File) {
      if (await pasteFileIntoComposer(file, selectors)) return
      if (await attachFileToInput(file)) return
      throw new Error('deepseek image upload failed')
    },

    async getLastResponse() {
      return getResponseTextWithFallback(selectors)
    },

    async getConversationState(): Promise<ConversationState> {
      const hasInputBox = !!queryFirst(selectors.inputBox)
      logCaptureDebug({
        platform: 'deepseek',
        event: 'conversation-state-check',
        hasInputBox,
      })
      if (!hasInputBox) return { status: 'error', errorMessage: 'DeepSeek 输入框未识别', stopButtonDetected: false }
      const lastResponse = getResponseTextWithFallback(selectors)
      const hasStopButton = hasStopGeneratingButton(selectors)
      const state: ConversationState = hasStopButton
        ? { status: 'streaming', lastResponse, stopButtonDetected: true }
        : lastResponse
          ? { status: 'finished', lastResponse, stopButtonDetected: false }
          : { status: 'idle', stopButtonDetected: false }
      logCaptureDebug({
        platform: 'deepseek',
        event: 'conversation-state-result',
        hasInputBox,
        hasStopButton,
        lastResponseLength: lastResponse?.length ?? 0,
        lastResponsePreview: textPreview(lastResponse ?? ''),
        status: state.status,
      })
      return state
    },
  }
}
