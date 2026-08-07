import type { AIPlatform } from '../types'
import { DEEPSEEK_SELECTOR_VERSION, createDeepSeekAdapter, ensureDeepSeekVisionMode } from '../adapters/deepseek/adapter'
import { bootContentScript } from '../adapters/shared/content-script-bootstrap'
import { createLoginProbe } from '../adapters/shared/login-probe'

const PLATFORM: AIPlatform = 'deepseek'

async function boot(): Promise<void> {
  await bootContentScript({
    platform: PLATFORM,
    selectorVersion: DEEPSEEK_SELECTOR_VERSION,
    createAdapter: createDeepSeekAdapter,
    createExtensionHandler: (adapter) => {
      const probe = createLoginProbe({
        platformName: 'DeepSeek',
        loginUrlKeywords: ['login', 'sign'],
        loginBodyPattern: /登录|log in|sign in/i,
      })

      return async ({ command }) => {
        if (command === 'get-state') {
          const state = await adapter.getConversationState().catch(() => probe.getProbeState())
          return {
            handled: true,
            data: state.status === 'error' ? probe.getProbeState() : state,
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
      }
    },
  })

  void ensureDeepSeekVisionMode()
}

void boot()
