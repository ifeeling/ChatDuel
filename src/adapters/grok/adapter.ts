import { createTextWebAdapter } from '../generic/text-web-adapter'
import type { SelectorOverrideMap } from '../../lib/remote-selector-config'

export function createGrokAdapter(selectorOverrides?: SelectorOverrideMap) {
  return createTextWebAdapter({
    platform: 'grok',
    loginErrorMessage: 'Grok 输入框未识别，可能尚未登录或页面未加载完成',
    inputNotFoundMessage: 'grok input box not found',
    sendNotFoundMessage: 'grok send button not found',
  }, selectorOverrides)
}
