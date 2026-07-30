import { GEMINI_SELECTOR_VERSION, createGeminiAdapter } from '../adapters/gemini/adapter'
import { installContentScriptCommandBridge } from './content-script-command-bridge'
import { loadSelectorConfig } from './selector-overrides'

async function boot(): Promise<void> {
  const selectorConfig = await loadSelectorConfig('gemini', GEMINI_SELECTOR_VERSION)
  const adapter = createGeminiAdapter(selectorConfig.selectors)

  installContentScriptCommandBridge({
    platform: 'gemini',
    adapter,
    selectorConfigVersion: selectorConfig.version,
  })
}

void boot()
