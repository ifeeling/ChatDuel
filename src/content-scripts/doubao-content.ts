import type { AIPlatform } from '../types'
import { DOUBAO_SELECTOR_VERSION, createDoubaoAdapter } from '../adapters/doubao/adapter'
import { bootContentScript } from '../adapters/shared/content-script-bootstrap'
import { createLoginProbeExtensionHandler } from '../adapters/shared/login-probe'

const PLATFORM: AIPlatform = 'doubao'

void bootContentScript({
  platform: PLATFORM,
  selectorVersion: DOUBAO_SELECTOR_VERSION,
  createAdapter: createDoubaoAdapter,
  createExtensionHandler: createLoginProbeExtensionHandler({
    platformName: '豆包',
    loginUrlKeywords: ['login', 'passport', 'sso'],
    loginBodyPattern: /登录|扫码登录|手机号登录|验证码登录/,
  }),
})
