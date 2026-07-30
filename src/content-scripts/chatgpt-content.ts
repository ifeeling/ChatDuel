import { CHATGPT_SELECTOR_VERSION, createChatGPTAdapter } from '../adapters/chatgpt/adapter'
import { installContentScriptCommandBridge } from './content-script-command-bridge'
import { loadSelectorConfig } from './selector-overrides'

async function boot(): Promise<void> {
  const selectorConfig = await loadSelectorConfig('chatgpt', CHATGPT_SELECTOR_VERSION)
  const adapter = createChatGPTAdapter(selectorConfig.selectors)

  installContentScriptCommandBridge({
    platform: 'chatgpt',
    adapter,
    selectorConfigVersion: selectorConfig.version,
  })
}

void boot()
