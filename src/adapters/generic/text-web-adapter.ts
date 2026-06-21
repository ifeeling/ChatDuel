import type { AIAdapter } from '../base'
import type { AIPlatform, ConversationState } from '../../types'
import { elementToMarkdownText } from '../../lib/dom-response-text'
import { mergeSelectorOverrides, type SelectorOverrideMap } from '../../lib/remote-selector-config'

const DEFAULT_INPUT_SELECTORS = [
  'textarea[placeholder*="Message" i]',
  'textarea[placeholder*="Ask" i]',
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
  'button[data-testid*="send" i]',
  'button[type="submit"]',
  '[role="button"][aria-label*="Send" i]',
  '[role="button"][title*="Send" i]',
  'button[aria-label*="发送"]',
  'button[title*="发送"]',
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

interface TextWebSelectors {
  [key: string]: string[]
  inputBox: string[]
  sendButton: string[]
  response: string[]
}

interface TextWebAdapterOptions {
  platform: AIPlatform
  selectors?: Partial<TextWebSelectors>
  loginErrorMessage: string
  inputNotFoundMessage: string
  sendNotFoundMessage: string
}

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

function findSendControl(selectors: TextWebSelectors): HTMLElement | null {
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

function isHidden(el: HTMLElement): boolean {
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true
  const style = window.getComputedStyle?.(el)
  return style?.display === 'none' || style?.visibility === 'hidden'
}

function elementMarker(el: HTMLElement): string {
  return [
    el.getAttribute('data-testid') ?? '',
    el.getAttribute('data-role') ?? '',
    el.className?.toString() ?? '',
    el.getAttribute('aria-label') ?? '',
  ].join(' ')
}

function responseCandidateScore(el: HTMLElement, text: string): number {
  const marker = elementMarker(el)
  let score = 0
  if (/\b(assistant|answer|markdown)\b/i.test(marker) || el.matches('article, [role="article"]')) score += 100
  if (/\b(user|human|question|query|prompt|composer|input)\b/i.test(marker)) score -= 100
  if (el.closest('main')) score += 10
  score += Math.min(text.length, 1000) / 100
  return score
}

function getLatestResponseText(selectors: TextWebSelectors): string {
  const seen = new Set<string>()
  const candidates = [...document.querySelectorAll<HTMLElement>(selectors.response.join(','))]
    .filter((el) => !isHidden(el))
    .filter((el) => !el.closest(RESPONSE_EXCLUDE_ANCESTORS))
    .map((el, index) => {
      const text = elementToMarkdownText(el)
      return { text, score: responseCandidateScore(el, text), index }
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

  return candidates[candidates.length - 1]?.text ?? ''
}

export function createTextWebAdapter(options: TextWebAdapterOptions, selectorOverrides?: SelectorOverrideMap): AIAdapter {
  const defaults: TextWebSelectors = {
    inputBox: options.selectors?.inputBox ?? DEFAULT_INPUT_SELECTORS,
    sendButton: options.selectors?.sendButton ?? DEFAULT_SEND_BUTTON_SELECTORS,
    response: options.selectors?.response ?? DEFAULT_RESPONSE_SELECTORS,
  }
  const selectors = mergeSelectorOverrides(defaults, selectorOverrides) as TextWebSelectors

  return {
    async isLoggedIn() {
      return !!queryFirst(selectors.inputBox)
    },

    async writeText(text: string) {
      const box = queryFirst<HTMLElement>(selectors.inputBox)
      if (!box) throw new Error(options.inputNotFoundMessage)
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
      if (!box) throw new Error(options.sendNotFoundMessage)
      dispatchEnter(box)
    },

    async sendMessage(text: string) {
      await this.writeText(text)
      await new Promise((resolve) => setTimeout(resolve, 120))
      await this.triggerSend()
    },

    async attachImage() {
      throw new Error(`${options.platform} image upload is not enabled`)
    },

    async getLastResponse() {
      return getLatestResponseText(selectors)
    },

    async getConversationState(): Promise<ConversationState> {
      if (!queryFirst(selectors.inputBox)) return { status: 'error', errorMessage: options.loginErrorMessage }
      const lastResponse = getLatestResponseText(selectors)
      if (lastResponse) return { status: 'finished', lastResponse }
      return { status: 'idle' }
    },

    onStreamEvent() {
      return () => {}
    },

    async detectRateLimit() {
      return false
    },
  }
}
