import type { AIAdapter, AdapterDiagnostics, AdapterSendInternals } from '../base'
import { emitDiagnostic } from '../shared/diagnostics'
import { attachImageToFileInput } from '../shared/file-input'
import { writeEditableValue, waitForSendAccepted } from '../shared/dom-write'
import { hasStopGeneratingButton } from '../shared/ds-doubao-shared'
import type { ConversationState } from '../../types'
import { mergeSelectorOverrides, type SelectorOverrideMap } from '../../lib/remote-selector-config'
import selectorsJson from './selectors.json'

type ChatGPTSelectors = typeof selectorsJson.selectors
const DEFAULT_SELECTORS = selectorsJson.selectors
export const CHATGPT_SELECTOR_VERSION = selectorsJson.version
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// chatgpt.com 的输入框是 contenteditable div(ProseMirror/TipTap 风格),
// 不是 textarea。contenteditable 的内容本来就在 DOM 里,没有 React state
// 包装层(ProseMirror 用 MutationObserver 监听 DOM 变化),所以**不需要**
// 走原生 value setter,直接 .textContent = + dispatch input 事件即可。
//
// 【发送】与 Gemini 不同:ChatGPT 的提交由 React 18 合成 click 驱动,
// btn.click() 即可工作(React 18 通过 document 上的事件委托接收原生
// click 并派发合成事件;对 click 事件 isTrusted 不严格检查)。
// 详见 docs/postmortems/2026-06-09-gemini-send-button.md §4


// 等 ChatGPT 上传流水线跑完(没图时不做事)。
// 标志: send 按钮变 enabled + input 旁边出现缩略图(图片 input dataURL)
async function waitForUploadReady(maxMs = 3000): Promise<void> {
  if (!document.querySelector("input[type='file']")) return
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    // 缩略图出现就视为就绪
    const hasThumb = document.querySelector('img[src^="data:"]')
    const sendBtn = document.querySelector<HTMLButtonElement>("button[data-testid='send-button']")
    if (hasThumb && sendBtn && !sendBtn.disabled) return
    await sleep(100)
  }
}

function isButtonDisabled(btn: HTMLButtonElement): boolean {
  return btn.disabled || btn.getAttribute('aria-disabled') === 'true' || btn.dataset.disabled === 'true'
}

function composerHasPendingContent(selectors: ChatGPTSelectors): boolean {
  const box = document.querySelector<HTMLElement>(selectors.inputBox)
  const text = box?.textContent?.replace(/\u200b/g, '').trim() ?? ''
  const hasAttachmentPreview = !!document.querySelector(
    [
      "[data-testid*='attachment' i]",
      "[data-testid*='file' i]",
      "img[src^='data:']",
      "img[alt*='upload' i]",
      "img[alt*='上传' i]",
    ].join(','),
  )
  return text.length > 0 || hasAttachmentPreview
}

async function waitForSendButtonReady(selectors: ChatGPTSelectors, maxMs = 8000): Promise<HTMLButtonElement> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const btn = document.querySelector<HTMLButtonElement>(selectors.sendButton)
    if (btn && !isButtonDisabled(btn)) return btn
    await sleep(100)
  }
  throw new Error('send button is not ready')
}

export function createChatGPTAdapter(selectorOverrides?: SelectorOverrideMap): AIAdapter & AdapterSendInternals {
  const S = mergeSelectorOverrides(DEFAULT_SELECTORS, selectorOverrides)

  function q<T extends Element = Element>(sel: string): T | null {
    return document.querySelector<T>(sel)
  }

  function last<T extends Element = Element>(sel: string): T | null {
    const nodes = document.querySelectorAll<T>(sel)
    return nodes.length > 0 ? nodes[nodes.length - 1] : null
  }

  return {
    async writeText(text: string) {
      const box = q<HTMLElement>(S.inputBox)
      if (!box) throw new Error('input box not found')
      writeEditableValue(box, text, 'input-then-beforeinput')
    },

    async triggerSend() {
      const btn = await waitForSendButtonReady(S)
      btn.click()
    },

    async sendMessage(text: string, image?: File, diagnostics?: AdapterDiagnostics) {
      const inputCharacterCount = text.length
      const box = q<HTMLElement>(S.inputBox)
      if (!box) {
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter',
          operation: 'input-locate',
          stage: 'failed',
          eventStatus: 'failed',
          runOutcome: 'failed',
          errorCode: 'input-box-not-found',
          inputCharacterCount,
        })
        throw new Error('input box not found')
      }
      emitDiagnostic(diagnostics, {
        component: 'platform-adapter',
        operation: 'input-locate',
        stage: 'located',
        eventStatus: 'succeeded',
        inputCharacterCount,
      })
      try {
        writeEditableValue(box, text, 'input-then-beforeinput')
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter',
          operation: 'input-write',
          stage: 'written',
          eventStatus: 'succeeded',
          inputCharacterCount,
        })
      } catch {
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter',
          operation: 'input-write',
          stage: 'failed',
          eventStatus: 'failed',
          runOutcome: 'failed',
          errorCode: 'input-write-failed',
          inputCharacterCount,
        })
        throw new Error('input write failed')
      }
      // 写完文字再附加图片(等 React/Quill 状态稳定)
      await new Promise((r) => setTimeout(r, 50))
      if (image) {
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'attachment-prepare', stage: 'preparing', eventStatus: 'observed', hasAttachment: true,
        })
        try {
          await this.attachImage(image)
          // 等上传组件把缩略图渲染进 input,并等 AI 网站自己的图片处理流水线跑完
          await waitForUploadReady()
          emitDiagnostic(diagnostics, {
            component: 'platform-adapter', operation: 'attachment-prepare', stage: 'prepared', eventStatus: 'succeeded', hasAttachment: true,
          })
        } catch {
          emitDiagnostic(diagnostics, {
            component: 'platform-adapter',
            operation: 'attachment-prepare',
            stage: 'failed',
            eventStatus: 'failed',
            runOutcome: 'failed',
            errorCode: 'attachment-preparation-timeout',
            hasAttachment: true,
          })
          throw new Error('attachment preparation failed')
        }
      } else {
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'attachment-prepare', stage: 'skipped', eventStatus: 'skipped', hasAttachment: false,
        })
      }
      // 给 React/ProseMirror 一个微任务让状态更新,再点发送按钮
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const retryNumber = attempt + 1
        try {
          await this.triggerSend()
        } catch {
          emitDiagnostic(diagnostics, {
            component: 'platform-adapter',
            operation: 'send-click',
            stage: 'timed-out',
            eventStatus: 'timed-out',
            runOutcome: 'timed-out',
            errorCode: 'send-button-not-ready',
            retryNumber,
            timeoutMs: 8_000,
          })
          throw new Error('send button is not ready')
        }
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'send-click', stage: 'clicked', eventStatus: 'succeeded', retryNumber,
        })
        emitDiagnostic(diagnostics, {
          component: 'platform-adapter', operation: 'send-ack', stage: 'waiting', eventStatus: 'observed', retryNumber,
        })
        if (await waitForSendAccepted(() => hasStopGeneratingButton(S, { requireVisible: false, textFallback: false }) || !composerHasPendingContent(S))) {
          emitDiagnostic(diagnostics, {
            component: 'platform-adapter',
            operation: 'send-ack',
            stage: 'accepted',
            eventStatus: 'succeeded',
            retryNumber,
            retryCount: retryNumber,
          })
          return
        }
        await sleep(250)
      }
      emitDiagnostic(diagnostics, {
        component: 'platform-adapter',
        operation: 'send-ack',
        stage: 'failed',
        eventStatus: 'failed',
        runOutcome: 'failed',
        errorCode: 'message-not-accepted',
        retryCount: 3,
      })
      throw new Error('message was not accepted by ChatGPT composer')
    },

    async attachImage(file: File) {
      if (await attachImageToFileInput(file)) return
      throw new Error('file input not found for image upload')
    },

        getLastResponse() {
      return Promise.resolve(last(S.lastResponse)?.textContent ?? '')
    },

    getConversationState(): Promise<ConversationState> {
      const lastText = last(S.lastResponse)?.textContent ?? ''
      if (hasStopGeneratingButton(S, { requireVisible: false, textFallback: false })) return Promise.resolve({ status: 'streaming', lastResponse: lastText, stopButtonDetected: true })
      if (q(S.continueButton)) return Promise.resolve({ status: 'paused', lastResponse: lastText, stopButtonDetected: false })
      if (!lastText) return Promise.resolve({ status: 'idle', stopButtonDetected: false })
      return Promise.resolve({ status: 'finished', lastResponse: lastText, stopButtonDetected: false })
    },
  }
}
