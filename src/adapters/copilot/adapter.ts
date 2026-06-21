import { createTextWebAdapter } from '../generic/text-web-adapter'
import type { SelectorOverrideMap } from '../../lib/remote-selector-config'

export function createCopilotAdapter(selectorOverrides?: SelectorOverrideMap) {
  return createTextWebAdapter({
    platform: 'copilot',
    loginErrorMessage: 'Copilot 输入框未识别，可能尚未登录或页面未加载完成',
    inputNotFoundMessage: 'copilot input box not found',
    sendNotFoundMessage: 'copilot send button not found',
  }, selectorOverrides)
}
