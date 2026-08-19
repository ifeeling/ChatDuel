export interface PromptOptimizationAvailabilityInput {
  draftLength: number
  maxPromptLength: number
  /** 本地记录的今日剩余次数；null 表示未知（乐观地当作可用）。 */
  remainingToday: number | null
}

export function isPromptOptimizationAvailable(input: PromptOptimizationAvailabilityInput): boolean {
  if (input.draftLength <= 0) return false
  if (input.draftLength > input.maxPromptLength) return false
  if (input.remainingToday !== null && input.remainingToday <= 0) return false
  return true
}
