import type { OptimizePromptOutcome } from '../lib/prompt-optimization-client'

export const PROMPT_OPTIMIZATION_QUOTA_STORAGE_KEY = 'promptOptimizationQuota'

export type PromptOptimizationPhase =
  | { kind: 'idle' }
  | { kind: 'optimizing' }
  | { kind: 'previewing'; original: string; suggestion: string }
  | { kind: 'error' }

export interface PromptOptimizationState {
  phase: PromptOptimizationPhase
  /** 本地记录的今日剩余次数；null 表示未知（乐观地当作可用）。 */
  remainingToday: number | null
}

export interface PromptOptimizationQuotaState {
  /** 本地记录的 remainingToday 对应的自然日（yyyy-mm-dd）。 */
  date: string
  remainingToday: number
}

export interface PromptOptimizationCoordinatorDependencies {
  requestOptimize(prompt: string): Promise<OptimizePromptOutcome>
  loadQuotaState(): Promise<PromptOptimizationQuotaState | undefined>
  saveQuotaState(state: PromptOptimizationQuotaState): Promise<void>
  onStateChange(state: PromptOptimizationState): void
  now?(): number
}

export interface PromptOptimizationCoordinator {
  /** 触发入口：对给定草稿发起一次优化请求。 */
  optimize(draft: string): Promise<void>
  /** 确认入口：预览中调用会返回（可能已编辑过的）文字并回到 idle；其它阶段调用是空操作（返回 null）。 */
  confirm(editedText: string): string | null
  /** 丢弃当前预览/错误状态并回到 idle，不改动本地记录的额度。 */
  revert(): void
  getState(): PromptOptimizationState
}

function localDateStamp(timestamp: number): string {
  const d = new Date(timestamp)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function createPromptOptimizationCoordinator(
  deps: PromptOptimizationCoordinatorDependencies,
): PromptOptimizationCoordinator {
  const now = deps.now ?? Date.now
  let phase: PromptOptimizationPhase = { kind: 'idle' }
  let remainingToday: number | null = null

  function emitState() {
    deps.onStateChange({ phase, remainingToday })
  }

  void deps.loadQuotaState().then((stored) => {
    if (stored && stored.date === localDateStamp(now())) {
      remainingToday = stored.remainingToday
      emitState()
    }
  })

  return {
    async optimize(draft) {
      phase = { kind: 'optimizing' }
      emitState()

      const outcome = await deps.requestOptimize(draft)

      if (outcome.kind === 'success') {
        phase = { kind: 'previewing', original: draft, suggestion: outcome.text }
        remainingToday = outcome.remainingToday
        await deps.saveQuotaState({ date: localDateStamp(now()), remainingToday: outcome.remainingToday })
        emitState()
        return
      }

      if (outcome.kind === 'quota_exceeded') {
        phase = { kind: 'idle' }
        remainingToday = 0
        await deps.saveQuotaState({ date: localDateStamp(now()), remainingToday: 0 })
        emitState()
        return
      }

      phase = { kind: 'error' }
      emitState()
    },

    confirm(editedText) {
      if (phase.kind !== 'previewing') return null
      phase = { kind: 'idle' }
      emitState()
      return editedText
    },

    revert() {
      phase = { kind: 'idle' }
      emitState()
    },

    getState() {
      return { phase, remainingToday }
    },
  }
}
