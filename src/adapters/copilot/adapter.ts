import { createTextWebAdapter } from '../generic/text-web-adapter'
import type { SelectorOverrideMap } from '../../lib/remote-selector-config'

export function createCopilotAdapter(selectorOverrides?: SelectorOverrideMap) {
  return createTextWebAdapter({
    platform: 'copilot',
    selectors: {
      inputBox: [
        'textarea[data-testid="composer-input"]',
        'textarea[placeholder*="Message" i]',
        'textarea[aria-label*="Message" i]',
        'textarea',
        '[contenteditable="true"]',
        '[role="textbox"]',
      ],
      sendButton: [
        'button[data-testid="submit-button"]',
        'button[type="submit"]',
        'button[aria-label*="Send" i]',
        'button[title*="Send" i]',
      ],
    },
    loginErrorMessage: 'Copilot 输入框未识别，可能尚未登录或页面未加载完成',
    inputNotFoundMessage: 'copilot input box not found',
    sendNotFoundMessage: 'copilot send button not found',
  }, selectorOverrides)
}
