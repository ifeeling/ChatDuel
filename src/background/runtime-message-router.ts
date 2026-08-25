import type { StoredSelectorConfig } from '../lib/remote-selector-config'
import type { AIPlatform } from '../types'

export interface RuntimeMessageRouterDependencies {
  addChatTabId(id: number): Promise<void>
  removeChatTabId(id: number): Promise<{ wasTracked: boolean; shouldDisableRules: boolean }>
  enableEmbedRules(): Promise<void>
  disableEmbedRules(): Promise<void>
  findOfficialTab(platform: AIPlatform): Promise<{ id?: number } | null>
  getStoredSelectorConfig(platform: AIPlatform): Promise<StoredSelectorConfig>
  refreshRemoteSelectorConfig(): Promise<boolean>
}

function toErrorResponse(e: unknown): { ok: false; error: string } {
  return { ok: false, error: String(e) }
}

export function handleRuntimeMessage(
  message: Readonly<Record<string, unknown>>,
  sender: { tab?: { id?: number } },
  dependencies: RuntimeMessageRouterDependencies,
): Promise<unknown> | null {
  if (message.type === 'enable-embed-rules') {
    const tabId = sender.tab?.id
    return Promise.resolve()
      .then(async () => {
        if (tabId !== undefined) await dependencies.addChatTabId(tabId)
        await dependencies.enableEmbedRules()
      })
      .then(() => ({ ok: true }))
      .catch(toErrorResponse)
  }
  if (message.type === 'disable-embed-rules') {
    const tabId = sender.tab?.id
    return Promise.resolve()
      .then(async () => {
        if (tabId === undefined) return
        const result = await dependencies.removeChatTabId(tabId)
        if (result.shouldDisableRules) await dependencies.disableEmbedRules()
      })
      .then(() => ({ ok: true }))
      .catch(toErrorResponse)
  }
  if (message.type === 'check-tab-exists') {
    return dependencies
      .findOfficialTab(message.platform as AIPlatform)
      .then((tab) => ({ ok: true, exists: !!tab }))
      .catch(toErrorResponse)
  }
  if (message.type === 'selector-config:get') {
    return dependencies
      .getStoredSelectorConfig(message.platform as AIPlatform)
      .then((config) => ({ ok: true, ...config }))
      .catch(toErrorResponse)
  }
  if (message.type === 'selector-config:refresh') {
    return dependencies
      .refreshRemoteSelectorConfig()
      .then((ok) => ({ ok }))
      .catch(toErrorResponse)
  }
  if (message.type === 'get-history') {
    // v1 暂未实现,先返回空数组
    return Promise.resolve({ ok: true, sessions: [] })
  }
  return null
}
