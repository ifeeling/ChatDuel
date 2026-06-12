import type { AIAdapter } from '../base'
import type { ConversationState, StreamEvent } from '../../types'

const INPUT_SELECTORS = [
  'textarea[placeholder*="发消息"]',
  'textarea',
  '[contenteditable="true"]',
  '[role="textbox"]',
]

const SEND_BUTTON_SELECTORS = [
  'button[aria-label*="发送"]',
  'button[title*="发送"]',
  'button[type="submit"]',
  '[role="button"][aria-label*="发送"]',
  '[role="button"][title*="发送"]',
]

const RESPONSE_SELECTORS = [
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

function queryFirst<T extends Element = Element>(selectors: string[]): T | null {
  for (const selector of selectors) {
    const el = document.querySelector<T>(selector)
    if (el) return el
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

function findSendControl(): HTMLElement | null {
  const direct = queryFirst<HTMLElement>(SEND_BUTTON_SELECTORS)
  if (direct) return direct

  const controls = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
  const textButton = controls.find((button) => /发送|send/i.test(button.textContent ?? ''))
  if (textButton) return textButton

  const input = queryFirst<HTMLElement>(INPUT_SELECTORS)
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

function elementText(el: HTMLElement): string {
  return normalizeText(el.innerText ?? el.textContent ?? '')
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

function responseCandidateScore(el: HTMLElement): number {
  const marker = elementMarker(el)
  let score = 0
  if (/\b(assistant|answer|markdown)\b/i.test(marker) || el.matches('article, [role="article"]')) score += 100
  if (/\b(recommend|suggest|guide|prompt|chip|card)\b/i.test(marker)) score -= 100
  if (el.closest('main')) score += 10
  return score
}

function getLatestResponseText(): string {
  const seen = new Set<string>()
  const candidates = [...document.querySelectorAll<HTMLElement>(RESPONSE_SELECTORS.join(','))]
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

export function createDoubaoAdapter(): AIAdapter {
  let lastEventHandler: ((e: StreamEvent) => void) | null = null

  return {
    async isLoggedIn() {
      return !!queryFirst(INPUT_SELECTORS)
    },

    async writeText(text: string) {
      const box = queryFirst<HTMLElement>(INPUT_SELECTORS)
      if (!box) throw new Error('doubao input box not found')
      if (box instanceof HTMLTextAreaElement) {
        writeNativeTextareaValue(box, text)
      } else {
        writeEditableValue(box, text)
      }
    },

    async triggerSend() {
      const btn = findSendControl()
      if (btn) {
        if (btn instanceof HTMLButtonElement && btn.disabled) btn.disabled = false
        activateControl(btn)
        return
      }
      const box = queryFirst<HTMLElement>(INPUT_SELECTORS)
      if (!box) throw new Error('doubao send button not found')
      dispatchEnter(box)
    },

    async sendMessage(text: string) {
      await this.writeText(text)
      await new Promise((resolve) => setTimeout(resolve, 80))
      await this.triggerSend()
    },

    async attachImage() {
      throw new Error('doubao image upload not supported')
    },

    async getLastResponse() {
      return getLatestResponseText()
    },

    async getConversationState(): Promise<ConversationState> {
      if (!queryFirst(INPUT_SELECTORS)) return { status: 'error', errorMessage: '豆包输入框未识别' }
      const lastResponse = getLatestResponseText()
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
