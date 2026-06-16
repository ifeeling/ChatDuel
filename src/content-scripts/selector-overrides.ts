import type { AIPlatform } from '../types'
import type { SelectorOverrideMap } from '../lib/remote-selector-config'

interface SelectorConfigReply {
  ok?: boolean
  selectors?: SelectorOverrideMap
}

export async function loadSelectorOverrides(platform: AIPlatform): Promise<SelectorOverrideMap | undefined> {
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'selector-config:get', platform }) as SelectorConfigReply
    return reply?.ok ? reply.selectors : undefined
  } catch {
    return undefined
  }
}
