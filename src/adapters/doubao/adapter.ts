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
      return ''
    },

    async getConversationState(): Promise<ConversationState> {
      if (!queryFirst(INPUT_SELECTORS)) return { status: 'error', errorMessage: '豆包输入框未识别' }
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
