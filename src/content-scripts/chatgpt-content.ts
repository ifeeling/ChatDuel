import { CHATGPT_SELECTOR_VERSION, createChatGPTAdapter } from '../adapters/chatgpt/adapter'
import { bootContentScript } from '../adapters/shared/content-script-bootstrap'

void bootContentScript({
  platform: 'chatgpt',
  selectorVersion: CHATGPT_SELECTOR_VERSION,
  createAdapter: createChatGPTAdapter,
})
