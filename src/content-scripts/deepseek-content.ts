import type { AIPlatform, ConversationState } from '../types'
import { DEEPSEEK_SELECTOR_VERSION, createDeepSeekAdapter, ensureDeepSeekVisionMode } from '../adapters/deepseek/adapter'
import { installContentScriptCommandBridge } from './content-script-command-bridge'
import { loadSelectorConfig } from './selector-overrides'

const PLATFORM: AIPlatform = 'deepseek'

async function boot(): Promise<void> {
  const selectorConfig = await loadSelectorConfig(PLATFORM, DEEPSEEK_SELECTOR_VERSION)
  const adapter = createDeepSeekAdapter(selectorConfig.selectors)

  function hasUsableComposer(): boolean {
    return !!document.querySelector([
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
    ].join(','))
  }

  function looksLikeLoginPage(): boolean {
    const url = location.href.toLowerCase()
    if (url.includes('login') || url.includes('sign')) return true

    const bodyText = (document.body?.innerText ?? '').slice(0, 2000)
    return /登录|log in|sign in/i.test(bodyText) && !hasUsableComposer()
  }

  function getProbeState(): ConversationState {
    if (looksLikeLoginPage()) {
      return { status: 'error', errorMessage: '可能未登录 DeepSeek' }
    }
    if (hasUsableComposer()) {
      return { status: 'idle' }
    }
    return { status: 'queued', errorMessage: 'DeepSeek 页面已注入，但尚未识别到输入框' }
  }

  installContentScriptCommandBridge({
    platform: PLATFORM,
    adapter,
    selectorConfigVersion: selectorConfig.version,
    extensionHandler: async ({ command }) => {
      if (command === 'get-state') {
        const state = await adapter.getConversationState().catch(() => getProbeState())
        return {
          handled: true,
          data: state.status === 'error' ? getProbeState() : state,
        }
      }
      if (command === 'get-conversation-url') {
        // DeepSeek 的侧边栏中所有对话链接格式为 /a/chat/s/<uuid>
        // 第一个链接对应当前活跃会话
        const link = document.querySelector<HTMLAnchorElement>('a[href*="/a/chat/s/"]')
        const href = link?.getAttribute('href') ?? ''
        return {
          handled: true,
          data: href ? new URL(href, location.origin).href : '',
        }
      }
      return { handled: false }
    },
  })

  void ensureDeepSeekVisionMode()
}

void boot()
