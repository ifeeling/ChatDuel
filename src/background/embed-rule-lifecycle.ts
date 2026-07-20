export interface ChatTabRemovalResult {
  remainingTabIds: Set<number>
  wasTracked: boolean
  shouldDisableRules: boolean
}

export function removeTrackedChatTab(trackedTabIds: ReadonlySet<number>, tabId: number): ChatTabRemovalResult {
  const remainingTabIds = new Set(trackedTabIds)
  const wasTracked = remainingTabIds.delete(tabId)

  return {
    remainingTabIds,
    wasTracked,
    shouldDisableRules: wasTracked && remainingTabIds.size === 0,
  }
}
