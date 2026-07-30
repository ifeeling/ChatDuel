import type { AIPlatform, ConversationState } from '../types'
import { DOUBAO_SELECTOR_VERSION, createDoubaoAdapter } from '../adapters/doubao/adapter'
import { installContentScriptCommandBridge } from './content-script-command-bridge'
import { loadSelectorConfig } from './selector-overrides'

const PLATFORM: AIPlatform = 'doubao'

async function boot(): Promise<void> {
  const selectorConfig = await loadSelectorConfig(PLATFORM, DOUBAO_SELECTOR_VERSION)
  const adapter = createDoubaoAdapter(selectorConfig.selectors)

  function hasUsableComposer(): boolean {
    return !!document.querySelector([
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ].join(','))
  }

  function looksLikeLoginPage(): boolean {
    const url = location.href.toLowerCase()
    if (url.includes('login') || url.includes('passport') || url.includes('sso')) return true

    const bodyText = (document.body?.innerText ?? '').slice(0, 2000)
    return /登录|扫码登录|手机号登录|验证码登录/.test(bodyText) && !hasUsableComposer()
  }

  function getProbeState(): ConversationState {
    if (looksLikeLoginPage()) {
      return { status: 'error', errorMessage: '可能未登录豆包' }
    }
    if (hasUsableComposer()) {
      return { status: 'idle' }
    }
    return { status: 'queued', errorMessage: '豆包页面已注入，但尚未识别到输入框' }
  }

  installContentScriptCommandBridge({
    platform: PLATFORM,
    adapter,
    selectorConfigVersion: selectorConfig.version,
    extensionHandler: async ({ command }) => {
      if (command !== 'get-state') return { handled: false }
      const state = await adapter.getConversationState().catch(() => getProbeState())
      return {
        handled: true,
        data: state.status === 'error' ? getProbeState() : state,
      }
    },
  })
}

void boot()
