import type { AIPlatform } from '../types'
import { DEEPSEEK_SELECTOR_VERSION, createDeepSeekAdapter, ensureDeepSeekVisionMode } from '../adapters/deepseek/adapter'
import { bootContentScript } from '../adapters/shared/content-script-bootstrap'
import { createLoginProbeExtensionHandler } from '../adapters/shared/login-probe'

const PLATFORM: AIPlatform = 'deepseek'

const createGetStateHandler = createLoginProbeExtensionHandler({
  platformName: 'DeepSeek',
  loginUrlKeywords: ['login', 'sign'],
  loginBodyPattern: /登录|log in|sign in/i,
})

async function boot(): Promise<void> {
  await bootContentScript({
    platform: PLATFORM,
    selectorVersion: DEEPSEEK_SELECTOR_VERSION,
    createAdapter: createDeepSeekAdapter,
    createExtensionHandler: (adapter) => {
      const getState = createGetStateHandler(adapter)
      return async (context) => {
        if (context.command === 'get-conversation-url') {
          // DeepSeek 的侧边栏中所有对话链接格式为 /a/chat/s/<uuid>
          // 第一个链接对应当前活跃会话
          const link = document.querySelector<HTMLAnchorElement>('a[href*="/a/chat/s/"]')
          const href = link?.getAttribute('href') ?? ''
          return {
            handled: true,
            data: href ? new URL(href, location.origin).href : '',
          }
        }
        return getState(context)
      }
    },
  })

  void ensureDeepSeekVisionMode()
}

void boot()
