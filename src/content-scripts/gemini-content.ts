import { GEMINI_SELECTOR_VERSION, createGeminiAdapter } from '../adapters/gemini/adapter'
import { bootContentScript } from '../adapters/shared/content-script-bootstrap'

void bootContentScript({
  platform: 'gemini',
  selectorVersion: GEMINI_SELECTOR_VERSION,
  createAdapter: createGeminiAdapter,
})
