import type { AIPlatform } from '../types'
import type { SelectorOverrideMap } from '../lib/remote-selector-config'

interface SelectorConfigReply {
  ok?: boolean
  selectors?: SelectorOverrideMap
  version?: string
}

export interface LoadedSelectorConfig {
  selectors?: SelectorOverrideMap
  version: string
}

export async function loadSelectorConfig(platform: AIPlatform, localVersion: string): Promise<LoadedSelectorConfig> {
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'selector-config:get', platform }) as SelectorConfigReply
    if (reply?.ok && reply.selectors && reply.version) {
      return { selectors: reply.selectors, version: reply.version }
    }
  } catch {
    // 使用本地 selector 配置。
  }
  return { selectors: undefined, version: localVersion }
}

export async function loadSelectorOverrides(platform: AIPlatform): Promise<SelectorOverrideMap | undefined> {
  return (await loadSelectorConfig(platform, 'local')).selectors
}
