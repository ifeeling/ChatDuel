import type { AIAdapter } from '../base'
import type { ConversationState, StreamEvent } from '../../types'
import { buildDataTransferFromFile, dispatchPaste } from '../../lib/image-handler'
import { elementToMarkdownText } from '../../lib/dom-response-text'
import { describeCaptureElement, logCaptureDebug } from '../../lib/capture-debug'
import { mergeSelectorOverrides, type SelectorOverrideMap } from '../../lib/remote-selector-config'

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

async function attachFileToInput(file: File): Promise<boolean> {
  const input = findFileInput()
  if (!input) return false
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
  return waitForAttachmentEvidence(file, baseline, scope)
}

async function pasteFileIntoComposer(file: File, selectors: DeepSeekSelectors): Promise<boolean> {
  const box = queryFirst<HTMLElement>(selectors.inputBox)
  if (!box) return false
  const scope = findAttachmentScope(box)
  const baseline = attachmentEvidenceCount(file, scope)
  try {
    box.focus()
  } catch {
    /* focus may be blocked in embedded frames */
  }
  const dt = buildDataTransferFromFile(file)
  dispatchPaste(box, dt)
  dispatchPaste(box, dt, 'drop')
  return waitForAttachmentEvidence(file, baseline, scope)
}

function findAttachmentScope(anchor: HTMLElement): ParentNode {
  let scope: HTMLElement | null = anchor
  for (let depth = 0; scope.parentElement && depth < 6; depth += 1) {
    scope = scope.parentElement
    if (scope.querySelector('textarea, [contenteditable="true"], [role="textbox"]') && scope.querySelector('input[type="file"]')) {
      return scope
    }
  }
  return anchor.parentElement ?? document.body
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

  const controls = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
  const textButton = controls.find((button) => /发送|send/i.test(button.textContent ?? ''))
  if (textButton) return textButton

  const input = queryFirst<HTMLElement>(selectors.inputBox)
  if (!input) return null
  let scope: HTMLElement | null = input.parentElement
  for (let depth = 0; scope && depth < 5; depth += 1, scope = scope.parentElement) {
    const scopedControls = [...scope.querySelectorAll<HTMLElement>('button, [role="button"]')]
      .filter((button) => !(button instanceof HTMLButtonElement && button.disabled))
    if (scopedControls.length > 0) return scopedControls[scopedControls.length - 1]
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
      return { el: expanded.el, text: expanded.text, score: responseCandidateScore(expanded.el, expanded.text), index }
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
      const btn = findSendControl(selectors)
      if (btn) {
        if (btn instanceof HTMLButtonElement && btn.disabled) btn.disabled = false
        activateControl(btn)
        return
      }
      const box = queryFirst<HTMLElement>(selectors.inputBox)
      if (!box) throw new Error('deepseek send button not found')
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
