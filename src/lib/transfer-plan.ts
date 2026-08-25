import type { ConversationStateResult } from '../chat/platform-communication'

const SAFE_TRANSFER_STATUSES = ['idle', 'finished', 'error']

function isBusyStatus(status: string): boolean {
  return !SAFE_TRANSFER_STATUSES.includes(status)
}

export function isSourceBusy(state: ConversationStateResult): boolean {
  return Boolean(state.requestTimedOut) || isBusyStatus(state.status)
}

export function isTargetBusy(state: ConversationStateResult | null | undefined): boolean {
  return state != null && isBusyStatus(state.status)
}

export interface TruncatedTransferContent {
  content: string
  truncated: boolean
  originalLength: number
}

export function truncateTransferContent(content: string, maxLength: number): TruncatedTransferContent {
  if (content.length <= maxLength) return { content, truncated: false, originalLength: content.length }
  return { content: content.slice(0, maxLength), truncated: true, originalLength: content.length }
}
