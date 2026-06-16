import type { AIAdapter } from '../base'
import type { ConversationState, StreamEvent } from '../../types'
import { buildDataTransferFromFile, dispatchPaste } from '../../lib/image-handler'
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

interface DoubaoSelectors {
  [key: string]: string[]
  inputBox: string[]
  sendButton: string[]
  response: string[]
}

const DEFAULT_SELECTORS: DoubaoSelectors = {
  inputBox: DEFAULT_INPUT_SELECTORS,
  sendButton: DEFAULT_SEND_BUTTON_SELECTORS,
  response: DEFAULT_RESPONSE_SELECTORS,
}

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
  let scope: HTMLElement = input
  for (let depth = 0; scope.parentElement && depth < 5; depth += 1) {
    scope = scope.parentElement
    if (scope.querySelector('textarea, [contenteditable="true"], [role="textbox"]')) return scope
  }
  return input
}

function attachmentEvidenceCount(scope: HTMLElement, file: File): number {
  const mediaCount = scope.querySelectorAll('img, video, canvas').length
  const fileNameHit = normalizeText(scope.textContent ?? '').includes(file.name) ? 1 : 0
  const uploadMarks = scope.querySelectorAll('[class*="upload" i], [class*="attachment" i], [class*="file" i], [data-testid*="upload" i]').length
  return mediaCount + fileNameHit + uploadMarks
}

async function waitForAttachmentEvidence(scope: HTMLElement, file: File, baseline: number, maxMs = 1500): Promise<boolean> {
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

function elementText(el: HTMLElement): string {
  return removeTrailingSuggestionLines(normalizeText(el.innerText ?? el.textContent ?? ''))
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

function isLikelySuggestionLine(line: string): boolean {
  const text = line.trim()
  if (!text) return false
  if (/^[\d一二三四五六七八九十]+[.)、]/.test(text)) return false
  if (/^[•\-*]/.test(text)) return false
  return text.length <= 36 && (/[?？]$/.test(text) || /[→↗>]$/.test(text))
}

function removeTrailingSuggestionLines(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length <= 1) return text

  let trailingSuggestionCount = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!isLikelySuggestionLine(lines[index])) break
    trailingSuggestionCount += 1
  }

  if (trailingSuggestionCount < 2) return text
  const keepCount = Math.max(1, lines.length - trailingSuggestionCount)
  return lines.slice(0, keepCount).join('\n')
}

function responseCandidateScore(el: HTMLElement): number {
  const marker = elementMarker(el)
  let score = 0
  if (/\b(assistant|answer|markdown)\b/i.test(marker) || el.matches('article, [role="article"]')) score += 100
  if (/\b(recommend|suggest|guide|prompt|chip|card)\b/i.test(marker)) score -= 100
  if (el.closest('main')) score += 10
  return score
}

function getLatestResponseText(selectors: DoubaoSelectors): string {
  const seen = new Set<string>()
  const candidates = [...document.querySelectorAll<HTMLElement>(selectors.response.join(','))]
    .filter((el) => !isHidden(el))
    .filter((el) => !el.closest(RESPONSE_EXCLUDE_ANCESTORS))
    .filter((el) => !isUserMessage(el))
    .map((el, index) => ({ text: elementText(el), score: responseCandidateScore(el), index }))
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

  return candidates[candidates.length - 1]?.text ?? ''
}

export function createDoubaoAdapter(selectorOverrides?: SelectorOverrideMap): AIAdapter {
  const selectors = mergeSelectorOverrides(DEFAULT_SELECTORS, selectorOverrides) as DoubaoSelectors
  let lastEventHandler: ((e: StreamEvent) => void) | null = null

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

    async sendMessage(text: string, image?: File) {
      await this.writeText(text)
      await new Promise((resolve) => setTimeout(resolve, 80))
      if (image) await this.attachImage(image)
      await new Promise((resolve) => setTimeout(resolve, 200))
      await this.triggerSend()
    },

    async attachImage(file: File) {
      if (await attachImageToFileInput(file)) return
      if (await pasteImageIntoComposer(file, selectors)) return
      const probe = probeDoubaoAttachmentControls(selectorOverrides)
      throw new Error(`doubao image upload failed: ${probe.reason}`)
    },

    async getLastResponse() {
      return getLatestResponseText(selectors)
    },

    async getConversationState(): Promise<ConversationState> {
      if (!queryFirst(selectors.inputBox)) return { status: 'error', errorMessage: '豆包输入框未识别' }
      const lastResponse = getLatestResponseText(selectors)
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
