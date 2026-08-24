import { CHATGPT_SELECTOR_VERSION, createChatGPTAdapter } from '../adapters/chatgpt/adapter'
import { bootContentScript } from '../adapters/shared/content-script-bootstrap'
import { createLoginProbeExtensionHandler } from '../adapters/shared/login-probe'

void bootContentScript({
  platform: 'chatgpt',
  selectorVersion: CHATGPT_SELECTOR_VERSION,
  createAdapter: createChatGPTAdapter,
  createExtensionHandler: createLoginProbeExtensionHandler({
    platformName: 'ChatGPT',
    loginUrlKeywords: ['/auth/login', '/auth0/login'],
    loginBodyPattern: /log in|sign up|welcome back/i,
  }),
})
