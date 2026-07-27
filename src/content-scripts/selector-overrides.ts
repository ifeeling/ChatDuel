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

function compareSelectorVersions(left: string, right: string): number | null {
  const pattern = /^\d{4}\.\d{2}(?:\.\d+)?$/
  if (!pattern.test(left) || !pattern.test(right)) return null
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let i = 0; i < length; i += 1) {
    const difference = (leftParts[i] ?? 0) - (rightParts[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export async function loadSelectorConfig(platform: AIPlatform, localVersion: string): Promise<LoadedSelectorConfig> {
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'selector-config:get', platform }) as SelectorConfigReply
    if (reply?.ok && reply.selectors && reply.version) {
      const comparison = compareSelectorVersions(reply.version, localVersion)
      if (comparison === null || comparison >= 0) {
        return { selectors: reply.selectors, version: reply.version }
      }
    }
  } catch {
    // 使用本地 selector 配置。
  }
  return { selectors: undefined, version: localVersion }
}

export async function loadSelectorOverrides(platform: AIPlatform): Promise<SelectorOverrideMap | undefined> {
  return (await loadSelectorConfig(platform, 'local')).selectors
}
