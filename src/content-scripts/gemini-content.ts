import { GEMINI_SELECTOR_VERSION, createGeminiAdapter } from '../adapters/gemini/adapter'
import { bootContentScript } from '../adapters/shared/content-script-bootstrap'
import { createLoginProbeExtensionHandler } from '../adapters/shared/login-probe'

void bootContentScript({
  platform: 'gemini',
  selectorVersion: GEMINI_SELECTOR_VERSION,
  createAdapter: createGeminiAdapter,
  // Gemini 未登录时通常会跳出 gemini.google.com 域名整体重定向到
  // accounts.google.com（跨域，content-script 根本不会注入到那个页面），
  // 所以 URL 关键词在这里基本探测不到；body 正则是唯一还留在同域内的信号，
  // 覆盖它偶尔原地渲染"登录以继续"提示、还没来得及跳转的窗口期。
  createExtensionHandler: createLoginProbeExtensionHandler({
    platformName: 'Gemini',
    loginUrlKeywords: ['/accounts/', 'signin'],
    loginBodyPattern: /sign in|登录|log in to continue/i,
  }),
})
