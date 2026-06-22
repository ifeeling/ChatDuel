import { createTextWebAdapter } from '../generic/text-web-adapter'
import type { SelectorOverrideMap } from '../../lib/remote-selector-config'

export function createGrokAdapter(selectorOverrides?: SelectorOverrideMap) {
  return createTextWebAdapter({
    platform: 'grok',
    selectors: {
      inputBox: [
        'textarea[aria-label]',
        'textarea[placeholder*="Ask Grok" i]',
        'textarea[placeholder*="Ask" i]',
        'div[contenteditable="true"]',
        '[contenteditable="true"]',
        '[role="textbox"]',
        'textarea',
      ],
      sendButton: [
        'button[type="submit"]',
        'button[aria-label*="Send" i]',
        'button[title*="Send" i]',
        'button[data-testid*="send" i]',
        '[role="button"][aria-label*="Send" i]',
      ],
    },
    loginErrorMessage: 'Grok 输入框未识别，可能尚未登录或页面未加载完成',
    inputNotFoundMessage: 'grok input box not found',
    sendNotFoundMessage: 'grok send button not found',
  }, selectorOverrides)
}
