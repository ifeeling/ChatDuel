import type { AIAdapter, AdapterDiagnostics } from '../base'
import type { ConversationState, StreamEvent } from '../../types'
import { buildDataTransferFromFile, dispatchPaste } from '../../lib/image-handler'
import { elementToMarkdownText } from '../../lib/dom-response-text'
import { describeCaptureElement, logCaptureDebug } from '../../lib/capture-debug'
import { mergeSelectorOverrides, type SelectorOverrideMap } from '../../lib/remote-selector-config'

const DEFAULT_INPUT_SELECTORS = [
  'textarea[placeholder*="发消息"]',
  'textarea',
  '[contenteditable="true"]',
  '[role="textbox"]',
]

const DEFAULT_SEND_BUTTON_SELECTORS = [
  'button[aria-label*="发送"]',
  'button[title*="发送"]',
  'button[type="submit"]',
  '[role="button"][aria-label*="发送"]',
  '[role="button"][title*="发送"]',
]

const DEFAULT_STOP_BUTTON_SELECTORS = [
  'button[aria-label*="停止"]',
  'button[title*="停止"]',
  'button[aria-label*="中止"]',
  'button[title*="中止"]',
  'button[aria-label*="取消"]',
  'button[title*="取消"]',
  'button[aria-label*="stop" i]',
  'button[title*="stop" i]',
  'button[aria-label*="cancel" i]',
  'button[title*="cancel" i]',
  '[role="button"][aria-label*="停止"]',
  '[role="button"][title*="停止"]',
  '[role="button"][aria-label*="中止"]',
  '[role="button"][title*="中止"]',
  '[role="button"][aria-label*="取消"]',
  '[role="button"][title*="取消"]',
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

const RESPONSE_QUIET_FALLBACK_MS = 45_000
const COMPLETION_ACTION_BAR_SELECTORS = [
  '[class*="message-action-bar"]',
  '[data-foundation-type*="message-action-bar"]',
  '[data-testid*="message-action"]',
]

interface DoubaoSelectors {
  [key: string]: string[]
  inputBox: string[]
  sendButton: string[]
  stopButton: string[]
  response: string[]
}

const DEFAULT_SELECTORS: DoubaoSelectors = {
  inputBox: DEFAULT_INPUT_SELECTORS,
  sendButton: DEFAULT_SEND_BUTTON_SELECTORS,
  stopButton: DEFAULT_STOP_BUTTON_SELECTORS,
  response: DEFAULT_RESPONSE_SELECTORS,
}
export const DOUBAO_SELECTOR_VERSION = 'builtin-1'

export interface DoubaoAttachmentProbeResult {
  inputFound: boolean
  explicitFileInputFound: boolean
  imageFileInputFound: boolean
  documentFileInputFound: boolean
  misleadingCreationShortcutFound: boolean
  canAutoUploadImage: boolean
  canAutoUploadFile: boolean
  reason: string
}

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
    "input[type='file'][aria-label*='图片' i]",
    "input[type='file'][aria-label*='附件' i]",
    "input[type='file']",
  ]
  for (const selector of candidates) {
    const input = document.querySelector<HTMLInputElement>(selector)
    if (input) return input
  }
  return null
}

function composerScope(input: HTMLElement): HTMLElement {
  let best: HTMLElement | null = null
  let scope: HTMLElement = input
  for (let depth = 0; scope.parentElement && depth < 8; depth += 1) {
    scope = scope.parentElement
    if (scope === document.body || scope === document.documentElement) break
    if (scope.querySelector('textarea, [contenteditable="true"], [role="textbox"]')) best = scope
  }
  return best ?? input
}

function attachmentEvidenceCount(scope: HTMLElement, file: File): number {
  const mediaCount = scope.querySelectorAll('img, video, canvas').length
  const fileName = file.name.toLowerCase()
  const fileNameHit = [...scope.querySelectorAll<HTMLElement>('*')]
    .some((el) => {
      const marker = [
        el.textContent ?? '',
        el.getAttribute('alt') ?? '',
        el.getAttribute('title') ?? '',
        el.getAttribute('aria-label') ?? '',
      ].join(' ').toLowerCase()
      return marker.includes(fileName)
    }) ? 1 : 0
  const uploadMarks = scope.querySelectorAll('[class*="upload" i], [class*="attachment" i], [class*="file" i], [data-testid*="upload" i]').length
  return mediaCount + fileNameHit + uploadMarks
}

async function waitForAttachmentEvidence(scope: HTMLElement, file: File, baseline: number, maxMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    if (attachmentEvidenceCount(scope, file) > baseline) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

async function attachImageToFileInput(file: File): Promise<boolean> {
  const input = findFileInput()
  if (!input) return false
  const dt = buildDataTransferFromFile(file)
  try {
    input.files = dt.files
  } catch {
    Object.defineProperty(input, 'files', { value: dt.files, configurable: true })
  }
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}

async function pasteImageIntoComposer(file: File, selectors: DoubaoSelectors): Promise<boolean> {
  const box = queryFirst<HTMLElement>(selectors.inputBox)
  if (!box) return false
  const scope = composerScope(box)
  const baseline = attachmentEvidenceCount(scope, file)
  try {
    box.focus()
  } catch {
    /* focus may be blocked in embedded frames */
  }
  dispatchPaste(box, buildDataTransferFromFile(file))
  return waitForAttachmentEvidence(scope, file, baseline)
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

function findSendControl(selectors: DoubaoSelectors): HTMLElement | null {
  const direct = queryFirst<HTMLElement>(selectors.sendButton)
  if (direct) return direct

  const controls = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
  const textButton = controls.find((button) => /发送|send/i.test(button.textContent ?? ''))
  if (textButton) return textButton

  const input = queryFirst<HTMLElement>(selectors.inputBox)
  if (!input) return null
  let scope: HTMLElement | null = input.parentElement
  for (let depth = 0; scope && depth < 5; depth += 1, scope = scope.parentElement) {
    const scopedControls = [...scope.querySelectorAll<HTMLElement>('button, [role="button"]')]
      .filter((button) => !(button instanceof HTMLButtonElement && button.disabled))
    const inputIndex = scopedControls.findIndex((button) => {
      const position = button.compareDocumentPosition(input)
      return (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    })
    const afterInput = inputIndex >= 0 ? scopedControls.slice(inputIndex + 1) : scopedControls
    if (afterInput.length > 0) return afterInput[afterInput.length - 1]
  }
  return null
}

function hasStopGeneratingButton(selectors: DoubaoSelectors): boolean {
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

function hasPendingContent(selectors: DoubaoSelectors): boolean {
  const box = queryFirst<HTMLElement>(selectors.inputBox)
  if (!box) return false
  const text = box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement
    ? box.value
    : box.textContent ?? ''
  return text.trim().length > 0
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
  el.dispatchEvent(new KeyboardEvent('keydown', init))
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

function fileInputAccepts(input: HTMLInputElement, patterns: RegExp[]): boolean {
  const accept = input.accept.toLowerCase()
  if (!accept) return true
  return patterns.some((pattern) => pattern.test(accept))
}

export function probeDoubaoAttachmentControls(selectorOverrides?: SelectorOverrideMap): DoubaoAttachmentProbeResult {
  const selectors = mergeSelectorOverrides(DEFAULT_SELECTORS, selectorOverrides) as DoubaoSelectors
  const inputFound = !!queryFirst(selectors.inputBox)
  const fileInputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')]
  const explicitFileInputFound = fileInputs.length > 0
  const imageFileInputFound = fileInputs.some((input) => fileInputAccepts(input, [/image\/\*/, /image\//, /\.png/, /\.jpe?g/, /\.webp/, /\.gif/]))
  const documentFileInputFound = fileInputs.some((input) => fileInputAccepts(input, [/\.pdf/, /\.xlsx/, /application\/pdf/, /spreadsheet/]))
  const misleadingCreationShortcutFound = [...document.querySelectorAll<HTMLElement>('button, [role="button"], a')]
    .some((el) => /图像生成|AI 创作|帮我写作|编程/.test(normalizeText(el.textContent ?? '')))

  return {
    inputFound,
    explicitFileInputFound,
    imageFileInputFound,
    documentFileInputFound,
    misleadingCreationShortcutFound,
    canAutoUploadImage: imageFileInputFound,
    canAutoUploadFile: false,
    reason: imageFileInputFound ? '发现图片上传入口' : '未发现豆包可自动使用的上传入口',
  }
}

function isHidden(el: HTMLElement): boolean {
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true
  const style = window.getComputedStyle?.(el)
  return style?.display === 'none' || style?.visibility === 'hidden'
}

function isUserMessage(el: HTMLElement): boolean {
  const marker = elementMarker(el)
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

function isSuggestionNode(el: HTMLElement): boolean {
  const marker = elementMarker(el)
  return /\b(suggest-list-item|suggest-message|suggestion|recommend-item)\b/i.test(marker)
}

function cloneWithoutSuggestionNodes(el: HTMLElement): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement
  if (isSuggestionNode(clone)) return document.createElement('div')
  for (const suggestion of clone.querySelectorAll<HTMLElement>('*')) {
    if (isSuggestionNode(suggestion)) suggestion.remove()
  }
  return clone
}

function cleanDoubaoResponseText(text: string): string {
  const cleanedLines = normalizeText(text)
    .split('\n')
    .map((line) => line.trim())
    .map((line) => line
      .replace(/^搜索\s*\d+\s*个?关键词[，,]?\s*参考\s*\d+\s*篇资料\s*/u, '')
      .replace(/^搜索\s*\d+\s*个?关键词[，,]?\s*/u, '')
      .replace(/^参考\s*\d+\s*篇资料\s*/u, '')
      .replace(/\s*参考\s*\d+\s*篇资料$/u, '')
      .trim())
    .filter(Boolean)
  return removeTrailingSuggestionLines(cleanedLines.join('\n'))
}

function elementText(el: HTMLElement): string {
  return cleanDoubaoResponseText(elementToMarkdownText(cloneWithoutSuggestionNodes(el)))
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

function isLikelySuggestionLine(line: string): boolean {
  const text = line.trim()
  if (!text) return false
  if (/^[\d一二三四五六七八九十]+[.)、]/.test(text)) return false
  if (/^[•\-*]/.test(text)) return false
  return text.length <= 36 && (/[?？]$/.test(text) || /[→↗>]$/.test(text))
}

function isConversationListContainer(el: HTMLElement): boolean {
  return /\b(message-list|v_list)\b/i.test(elementMarker(el))
}

function collectResponseCandidateElements(selectors: DoubaoSelectors): HTMLElement[] {
  const ordered = new Map<HTMLElement, HTMLElement>()
  for (const el of document.querySelectorAll<HTMLElement>(selectors.response.join(','))) {
    if (isConversationListContainer(el)) {
      for (const child of el.children) {
        if (child instanceof HTMLElement) ordered.set(child, child)
      }
      continue
    }
    ordered.set(el, el)
  }
  return [...ordered.values()]
}

function removeTrailingSuggestionLines(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length <= 1) return text

  let trailingSuggestionCount = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!isLikelySuggestionLine(lines[index])) break
    trailingSuggestionCount += 1
  }

  if (trailingSuggestionCount < 1) return text
  const keepCount = Math.max(1, lines.length - trailingSuggestionCount)
  return lines.slice(0, keepCount).join('\n')
}

function isSearchLoadingText(text: string): boolean {
  return /^正在搜索$|^搜索中|^找到\s*\d+\s*篇资料$/u.test(text.trim())
}

function isSearchResultWithAnswer(text: string): boolean {
  const stripped = text
    .replace(/^搜索\s*\d+\s*个?关键词[，,]?\s*/u, '')
    .replace(/参考\s*\d+\s*(篇|个|条)?资料/g, '')
    .trim()
  return /^搜索\s*\d+/u.test(text) && stripped.length > 0
}

function responseCandidateScore(el: HTMLElement): number {
  const marker = elementMarker(el)
  const text = elementText(el)
  let score = 0
  if (isConversationListContainer(el)) score -= 300
  if (/\b(assistant|answer|markdown)\b/i.test(marker) || el.matches('article, [role="article"]')) score += 100
  if (/\b(recommend|suggest|guide|prompt|chip|card|reference|references|source|sources|citation|search)\b/i.test(marker)) score -= 100
  if (/^(参考|引用|来源|已阅读)\s*\d+\s*(篇|个|条)?/.test(text)) score -= 200
  if (/^搜索\s*\d+\s*(篇|个|条)?/.test(text) && !isSearchResultWithAnswer(text)) score -= 200
  if (isSearchLoadingText(text)) score -= 200
  if (isSearchResultWithAnswer(text)) score += 80
  if (isLikelySuggestionLine(text)) score -= 100
  if (hasDirectResponseActions(el)) score += 120
  if (text.length <= 80 && !hasDirectResponseActions(el) && !isSearchResultWithAnswer(text)) score -= 20
  if (el.closest('main')) score += 10
  return score
}

function snapshotResponseCandidates(selectors: DoubaoSelectors): ReadonlyMap<HTMLElement, string> {
  return new Map(
    collectResponseCandidateElements(selectors)
      .map((el) => [el, elementText(el)] as const),
  )
}

interface DoubaoResponseCandidate {
  el: HTMLElement
  text: string
  score: number
  index: number
}

function getLatestResponseCandidate(
  selectors: DoubaoSelectors,
  excludedTexts: ReadonlySet<string> = new Set(),
  candidatesBeforeSend: ReadonlyMap<HTMLElement, string> = new Map(),
): DoubaoResponseCandidate | undefined {
  // 豆包会出现外层列表、搜索块和建议问题；改候选选择前先看 docs/RESPONSE_CAPTURE_MAINTENANCE.md。
  const seen = new Set<string>()
  const candidates = collectResponseCandidateElements(selectors)
    .filter((el) => !isHidden(el))
    .filter((el) => !el.closest(RESPONSE_EXCLUDE_ANCESTORS))
    .filter((el) => !isConversationListContainer(el))
    .filter((el) => !isUserMessage(el))
    .map((el, index) => ({ el, text: elementText(el), score: responseCandidateScore(el), index }))
    .filter((candidate) => candidate.text.length > 0)
    .filter((candidate) => !excludedTexts.has(normalizeText(candidate.text)))
    .filter((candidate) => !isSearchLoadingText(candidate.text))
    .filter((candidate) => candidatesBeforeSend.get(candidate.el) !== candidate.text)
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
    platform: 'doubao',
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

  return candidates[candidates.length - 1]
}

function getLatestResponseText(
  selectors: DoubaoSelectors,
  excludedTexts: ReadonlySet<string> = new Set(),
  candidatesBeforeSend: ReadonlyMap<HTMLElement, string> = new Map(),
): string {
  return getLatestResponseCandidate(selectors, excludedTexts, candidatesBeforeSend)?.text ?? ''
}

function isVisiblyRendered(el: HTMLElement): boolean {
  for (let current: HTMLElement | null = el; current; current = current.parentElement) {
    if (isHidden(current)) return false
    if (window.getComputedStyle?.(current).opacity === '0') return false
    if (current === document.body) break
  }
  return true
}

function appearsBefore(first: HTMLElement, second: HTMLElement): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

function hasVisibleCompletionActionBar(candidate: DoubaoResponseCandidate, selectors: DoubaoSelectors): boolean {
  const responseElements = collectResponseCandidateElements(selectors)
  return [...document.querySelectorAll<HTMLElement>(COMPLETION_ACTION_BAR_SELECTORS.join(','))]
    .filter((bar) => isVisiblyRendered(bar))
    .some((bar) => {
      if (candidate.el.contains(bar)) return true
      if (!appearsBefore(candidate.el, bar)) return false
      const hasInterveningResponse = responseElements.some((other) => {
        if (other === candidate.el || candidate.el.contains(other) || other.contains(candidate.el)) return false
        return appearsBefore(candidate.el, other) && appearsBefore(other, bar) && elementText(other).length > 0
      })
      return !hasInterveningResponse
    })
}

export function createDoubaoAdapter(selectorOverrides?: SelectorOverrideMap): AIAdapter {
  const selectors = mergeSelectorOverrides(DEFAULT_SELECTORS, selectorOverrides) as DoubaoSelectors
  let lastEventHandler: ((e: StreamEvent) => void) | null = null
  let activeSend: {
    prompt: string
    candidatesBeforeSend: ReadonlyMap<HTMLElement, string>
    lastObservedResponse: string
    lastResponseChangeAt: number
    completed: boolean
    completionActionBarDetected: boolean
    completionActionBarStableCount: number
  } | null = null

  function responseExclusions(): ReadonlySet<string> {
    return activeSend?.prompt ? new Set([activeSend.prompt]) : new Set()
  }

  function emit(diagnostics: AdapterDiagnostics | undefined, event: Parameters<AdapterDiagnostics['reporter']['emit']>[0]) {
    diagnostics?.reporter.emit({ ...event, selectorConfigVersion: diagnostics.selectorConfigVersion })
  }

  return {
    async isLoggedIn() {
      return !!queryFirst(selectors.inputBox)
    },

    async writeText(text: string) {
      const box = queryFirst<HTMLElement>(selectors.inputBox)
      if (!box) throw new Error('doubao input box not found')
      if (box instanceof HTMLTextAreaElement) {
        writeNativeTextareaValue(box, text)
      } else {
        writeEditableValue(box, text)
      }
    },

    async triggerSend() {
      const btn = findSendControl(selectors)
      if (btn) {
        if (btn instanceof HTMLButtonElement && btn.disabled) btn.disabled = false
        activateControl(btn)
        return
      }
      const box = queryFirst<HTMLElement>(selectors.inputBox)
      if (!box) throw new Error('doubao send button not found')
      dispatchEnter(box)
    },

    async sendMessage(text: string, image?: File, diagnostics?: AdapterDiagnostics) {
      const candidatesBeforeSend = snapshotResponseCandidates(selectors)
      const box = queryFirst<HTMLElement>(selectors.inputBox)
      if (!box) {
        emit(diagnostics, {
          component: 'platform-adapter', operation: 'input-locate', stage: 'failed', eventStatus: 'failed',
          runOutcome: 'failed', errorCode: 'input-box-not-found', inputCharacterCount: text.length,
        })
        throw new Error('doubao input box not found')
      }
      emit(diagnostics, {
        component: 'platform-adapter', operation: 'input-locate', stage: 'located', eventStatus: 'succeeded', inputCharacterCount: text.length,
      })
      try {
        if (box instanceof HTMLTextAreaElement) writeNativeTextareaValue(box, text)
        else writeEditableValue(box, text)
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
      await new Promise((resolve) => setTimeout(resolve, 80))
      if (image) {
        emit(diagnostics, {
          component: 'platform-adapter', operation: 'attachment-prepare', stage: 'preparing', eventStatus: 'observed', hasAttachment: true,
        })
        try {
          await this.attachImage(image)
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
      await new Promise((resolve) => setTimeout(resolve, 200))
      try {
        await this.triggerSend()
      } catch {
        emit(diagnostics, {
          component: 'platform-adapter', operation: 'send-click', stage: 'failed', eventStatus: 'failed',
          runOutcome: 'failed', errorCode: 'send-click-failed', retryNumber: 1,
        })
        throw new Error('doubao send failed')
      }
      activeSend = {
        prompt: normalizeText(text),
        candidatesBeforeSend,
        lastObservedResponse: '',
        lastResponseChangeAt: Date.now(),
        completed: false,
        completionActionBarDetected: false,
        completionActionBarStableCount: 0,
      }
      emit(diagnostics, {
        component: 'platform-adapter', operation: 'send-click', stage: 'clicked', eventStatus: 'succeeded', retryNumber: 1,
      })
      if (hasStopGeneratingButton(selectors) || !hasPendingContent(selectors)) {
        emit(diagnostics, {
          component: 'platform-adapter', operation: 'send-ack', stage: 'accepted', eventStatus: 'succeeded', retryNumber: 1, retryCount: 1,
        })
      } else {
        emit(diagnostics, {
          component: 'platform-adapter', operation: 'send-ack', stage: 'waiting', eventStatus: 'observed', retryNumber: 1, retryCount: 1,
        })
      }
    },

    async attachImage(file: File) {
      if (await attachImageToFileInput(file)) return
      if (await pasteImageIntoComposer(file, selectors)) return
      const probe = probeDoubaoAttachmentControls(selectorOverrides)
      throw new Error(`doubao image upload failed: ${probe.reason}`)
    },

    async getLastResponse() {
      if (activeSend?.completed) return activeSend.lastObservedResponse
      return getLatestResponseText(selectors, responseExclusions(), activeSend?.candidatesBeforeSend)
    },

    async getConversationState(): Promise<ConversationState> {
      if (!queryFirst(selectors.inputBox)) return { status: 'error', errorMessage: '豆包输入框未识别', stopButtonDetected: false }
      if (activeSend?.completed) {
        return {
          status: 'finished',
          lastResponse: activeSend.lastObservedResponse,
          stopButtonDetected: false,
          completionActionBarDetected: activeSend.completionActionBarDetected,
        }
      }
      const candidate = getLatestResponseCandidate(selectors, responseExclusions(), activeSend?.candidatesBeforeSend)
      const lastResponse = candidate?.text ?? ''
      if (hasStopGeneratingButton(selectors)) return { status: 'streaming', lastResponse, stopButtonDetected: true }
      if (activeSend) {
        const meaningfulResponse = lastResponse
        if (!meaningfulResponse) {
          return { status: 'streaming', lastResponse, stopButtonDetected: false }
        }
        const completionActionBarDetected = !!candidate && hasVisibleCompletionActionBar(candidate, selectors)
        activeSend.completionActionBarStableCount = completionActionBarDetected
          ? activeSend.completionActionBarStableCount + 1
          : 0
        if (meaningfulResponse !== activeSend.lastObservedResponse) {
          activeSend.lastObservedResponse = meaningfulResponse
          activeSend.lastResponseChangeAt = Date.now()
          return {
            status: 'streaming',
            lastResponse: meaningfulResponse,
            stopButtonDetected: false,
            completionActionBarDetected,
          }
        }
        if (activeSend.completionActionBarStableCount >= 2) {
          activeSend.completed = true
          activeSend.completionActionBarDetected = true
          return {
            status: 'finished',
            lastResponse: meaningfulResponse,
            stopButtonDetected: false,
            completionActionBarDetected: true,
          }
        }
        if (Date.now() - activeSend.lastResponseChangeAt < RESPONSE_QUIET_FALLBACK_MS) {
          return {
            status: 'streaming',
            lastResponse: meaningfulResponse,
            stopButtonDetected: false,
            completionActionBarDetected,
          }
        }
        activeSend.completed = true
        return {
          status: 'finished',
          lastResponse: meaningfulResponse,
          stopButtonDetected: false,
          completionActionBarDetected: false,
        }
      }
      if (lastResponse) return { status: 'finished', lastResponse, stopButtonDetected: false }
      return { status: 'idle', stopButtonDetected: false }
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
