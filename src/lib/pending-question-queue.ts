import type {
  AnswerCollectionPlatformResult,
  AnswerCollectionTaskResult,
} from './answer-collection-task'
import type { AIPlatform } from '../types'

export const MAX_PENDING_QUESTIONS = 5

export interface PendingQuestion {
  readonly id: string
  readonly taskId: string
  readonly text: string
  readonly targetPlatforms: readonly AIPlatform[]
}

export interface PendingQuestionDraft extends PendingQuestion {
  readonly hasAttachment?: boolean
}

export type QueuePauseReason =
  | 'all-sends-failed'
  | 'capture-timeout'
  | 'capture-interrupted'
  | 'history-unsaved'
  | 'user-stopped'
  | 'dispatch-failed'
  | 'unknown-result'

export type PendingQuestionQueueStatus = 'idle' | 'collecting' | 'paused'

export interface PendingQuestionQueueSnapshot {
  status: PendingQuestionQueueStatus
  activeTaskId: string | null
  activeTargetPlatforms: AIPlatform[]
  pauseReason: QueuePauseReason | null
  items: PendingQuestion[]
}

export type QueueTransition =
  | { kind: 'ignored' }
  | { kind: 'idle' }
  | { kind: 'dispatch'; next: PendingQuestion }
  | { kind: 'paused'; reason: QueuePauseReason }

type EnqueueResult =
  | { ok: true }
  | { ok: false; reason: 'attachment-unsupported' | 'empty' | 'full' | 'no-targets' }

function copyQuestion(question: PendingQuestion): PendingQuestion {
  return {
    id: question.id,
    taskId: question.taskId,
    text: question.text,
    targetPlatforms: [...question.targetPlatforms],
  }
}

function pauseReasonFor(
  result: AnswerCollectionTaskResult,
): QueuePauseReason | null {
  if (result.historyStatus === 'unsaved') return 'history-unsaved'

  const targets = result.session.targetPlatforms
  if (targets.length === 0) return 'unknown-result'

  const platformResults = targets.map((platform) => result.platforms[platform])
  if (platformResults.some((platformResult) => !platformResult)) return 'unknown-result'

  const statuses = platformResults.map(
    (platformResult) => (platformResult as AnswerCollectionPlatformResult).status,
  )
  if (statuses.includes('user-stopped')) return 'user-stopped'
  if (statuses.includes('capture-timeout')) return 'capture-timeout'
  if (statuses.includes('capture-interrupted')) return 'capture-interrupted'
  if (statuses.includes('observed-unsaved')) return 'history-unsaved'
  if (statuses.every((status) => status === 'send-failed')) return 'all-sends-failed'
  if (statuses.some((status) => status !== 'captured' && status !== 'send-failed')) {
    return 'unknown-result'
  }
  return null
}

export class PendingQuestionQueue {
  private items: PendingQuestion[] = []
  private activeTaskId: string | null = null
  private activeTargetPlatforms: AIPlatform[] = []
  private activeQueuedQuestion: PendingQuestion | null = null
  private pauseReason: QueuePauseReason | null = null

  enqueue(input: PendingQuestionDraft): EnqueueResult {
    if (input.hasAttachment) {
      return { ok: false, reason: 'attachment-unsupported' }
    }
    const text = input.text.trim()
    if (!text) return { ok: false, reason: 'empty' }
    if (this.items.length >= MAX_PENDING_QUESTIONS) {
      return { ok: false, reason: 'full' }
    }
    if (input.targetPlatforms.length === 0) {
      return { ok: false, reason: 'no-targets' }
    }
    this.items.push(copyQuestion({
      ...input,
      text,
    }))
    return { ok: true }
  }

  startTask(taskId: string, targetPlatforms: readonly AIPlatform[]): boolean {
    if (this.activeTaskId || this.pauseReason) return false
    this.activeTaskId = taskId
    this.activeTargetPlatforms = [...targetPlatforms]
    this.activeQueuedQuestion = null
    return true
  }

  finishTask(taskId: string, result: AnswerCollectionTaskResult): QueueTransition {
    if (this.activeTaskId !== taskId || result.id !== taskId) {
      return { kind: 'ignored' }
    }

    this.activeTaskId = null
    this.activeTargetPlatforms = []
    this.activeQueuedQuestion = null
    if (this.pauseReason) {
      return { kind: 'paused', reason: this.pauseReason }
    }

    const pauseReason = pauseReasonFor(result)
    if (pauseReason) {
      this.pauseReason = pauseReason
      return { kind: 'paused', reason: pauseReason }
    }

    const next = this.items.shift()
    if (!next) return { kind: 'idle' }

    this.activeTaskId = next.taskId
    this.activeTargetPlatforms = [...next.targetPlatforms]
    this.activeQueuedQuestion = copyQuestion(next)
    return { kind: 'dispatch', next: copyQuestion(next) }
  }

  pauseForUserStop(taskId: string): boolean {
    if (this.activeTaskId !== taskId) return false
    this.pauseReason = 'user-stopped'
    return true
  }

  pauseForDispatchFailure(taskId: string): boolean {
    if (this.activeTaskId !== taskId) return false
    if (this.activeQueuedQuestion) {
      this.items.unshift(copyQuestion(this.activeQueuedQuestion))
    }
    this.activeTaskId = null
    this.activeTargetPlatforms = []
    this.activeQueuedQuestion = null
    this.pauseReason = 'dispatch-failed'
    return true
  }

  pauseForTaskFailure(taskId: string): boolean {
    if (this.activeTaskId !== taskId) return false
    this.activeTaskId = null
    this.activeTargetPlatforms = []
    this.activeQueuedQuestion = null
    this.pauseReason = 'unknown-result'
    return true
  }

  snapshot(): PendingQuestionQueueSnapshot {
    return {
      status: this.pauseReason
        ? 'paused'
        : this.activeTaskId
          ? 'collecting'
          : 'idle',
      activeTaskId: this.activeTaskId,
      activeTargetPlatforms: [...this.activeTargetPlatforms],
      pauseReason: this.pauseReason,
      items: this.items.map(copyQuestion),
    }
  }
}
