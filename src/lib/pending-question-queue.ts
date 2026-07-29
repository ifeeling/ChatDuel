import type {
  AnswerCollectionPlatformResult,
  AnswerCollectionTaskResult,
} from './answer-collection-task'
import type { AIPlatform, StreamStatus } from '../types'
import type { PreparedAttachment } from './file-handler'

export const MAX_PENDING_QUESTIONS = 5
export const MAX_PENDING_ATTACHMENT_BYTES = 50 * 1024 * 1024

export interface PendingQuestion {
  readonly id: string
  readonly taskId: string
  readonly text: string
  readonly targetPlatforms: readonly AIPlatform[]
  readonly attachment?: PreparedAttachment | null
}

export type PendingQuestionDraft = Omit<PendingQuestion, 'attachment'> & {
  readonly attachment?: PreparedAttachment | null
}

export interface PendingQuestionUpdate {
  readonly text: string
  readonly targetPlatforms: readonly AIPlatform[]
  readonly attachment?: PreparedAttachment | null
}

export type PendingQuestionMutationResult =
  | { ok: true }
  | {
      ok: false
      reason: 'attachments-too-large' | 'empty' | 'missing' | 'no-targets'
    }

export type PendingQuestionMoveDirection = 'up' | 'down'

export type QueuePauseReason =
  | 'all-sends-failed'
  | 'capture-timeout'
  | 'capture-interrupted'
  | 'uncertain'
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
  pausedTargetPlatforms: AIPlatform[]
  resumeBlockedUntil: number | null
  items: PendingQuestion[]
}

export type QueueTransition =
  | { kind: 'ignored' }
  | { kind: 'idle' }
  | { kind: 'dispatch'; next: PendingQuestion }
  | { kind: 'paused'; reason: QueuePauseReason }

type EnqueueResult =
  | { ok: true }
  | {
      ok: false
      reason: 'attachments-too-large' | 'empty' | 'full' | 'no-targets'
    }

function copyAttachment(
  attachment: PreparedAttachment | null | undefined,
): PreparedAttachment | null {
  return attachment
    ? {
        file: attachment.file,
        classification: { ...attachment.classification },
        ...(attachment.textContent === undefined
          ? {}
          : { textContent: attachment.textContent }),
      }
    : null
}

function copyQuestion(question: PendingQuestion): PendingQuestion {
  return {
    id: question.id,
    taskId: question.taskId,
    text: question.text,
    targetPlatforms: [...question.targetPlatforms],
    attachment: copyAttachment(question.attachment),
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
  if (statuses.includes('uncertain')) return 'uncertain'
  if (statuses.includes('observed-unsaved')) return 'history-unsaved'
  if (statuses.every((status) => status === 'send-failed')) return 'all-sends-failed'
  if (statuses.some((status) => status !== 'captured' && status !== 'send-failed')) {
    return 'uncertain'
  }
  return null
}

export interface PlatformStateProbe {
  status: StreamStatus
  requestTimedOut?: boolean
}

// 重查闸门的核心判定：只有所有被暂停平台都确认「没有继续生成、没有排队发送、
// 状态请求没有超时或报错」时，才允许恢复队列。任何不确定情况一律判为不安全。
export function isPlatformStateSafeToResume(states: readonly PlatformStateProbe[]): boolean {
  return states.every(
    (state) =>
      state.status !== 'streaming'
      && state.status !== 'sending'
      && state.status !== 'queued'
      && state.status !== 'error'
      && state.requestTimedOut !== true,
  )
}

export class PendingQuestionQueue {
  private items: PendingQuestion[] = []
  private activeTaskId: string | null = null
  private activeTargetPlatforms: AIPlatform[] = []
  private activeQueuedQuestion: PendingQuestion | null = null
  private pauseReason: QueuePauseReason | null = null
  private pausedTargetPlatforms: AIPlatform[] = []
  private resumeBlockedUntil: number | null = null

  private setPause(reason: QueuePauseReason, platforms: readonly AIPlatform[]): void {
    this.pauseReason = reason
    this.pausedTargetPlatforms = [...platforms]
  }

  private queuedAttachmentBytes(): number {
    return this.items.reduce(
      (total, question) => total + (question.attachment?.file.size ?? 0),
      0,
    )
  }

  enqueue(input: PendingQuestionDraft): EnqueueResult {
    const text = input.text.trim()
    if (!text && !input.attachment) return { ok: false, reason: 'empty' }
    if (this.items.length >= MAX_PENDING_QUESTIONS) {
      return { ok: false, reason: 'full' }
    }
    if (input.targetPlatforms.length === 0) {
      return { ok: false, reason: 'no-targets' }
    }
    if (
      this.queuedAttachmentBytes() + (input.attachment?.file.size ?? 0)
      > MAX_PENDING_ATTACHMENT_BYTES
    ) {
      return { ok: false, reason: 'attachments-too-large' }
    }
    this.items.push(copyQuestion({
      ...input,
      text,
      attachment: input.attachment ?? null,
    }))
    return { ok: true }
  }

  update(id: string, input: PendingQuestionUpdate): PendingQuestionMutationResult {
    const index = this.items.findIndex((question) => question.id === id)
    const text = input.text.trim()
    if (index < 0) return { ok: false, reason: 'missing' }
    const current = this.items[index]
    const attachment = input.attachment === undefined
      ? current.attachment
      : input.attachment
    if (!text && !attachment) return { ok: false, reason: 'empty' }
    if (input.targetPlatforms.length === 0) return { ok: false, reason: 'no-targets' }
    const nextAttachmentBytes = this.queuedAttachmentBytes()
      - (current.attachment?.file.size ?? 0)
      + (attachment?.file.size ?? 0)
    if (nextAttachmentBytes > MAX_PENDING_ATTACHMENT_BYTES) {
      return { ok: false, reason: 'attachments-too-large' }
    }
    this.items[index] = copyQuestion({
      ...current,
      text,
      targetPlatforms: input.targetPlatforms,
      attachment,
    })
    return { ok: true }
  }

  remove(id: string): boolean {
    const index = this.items.findIndex((question) => question.id === id)
    if (index < 0) return false
    this.items.splice(index, 1)
    return true
  }

  move(id: string, direction: PendingQuestionMoveDirection): boolean {
    const index = this.items.findIndex((question) => question.id === id)
    const nextIndex = direction === 'up' ? index - 1 : index + 1
    if (index < 0 || nextIndex < 0 || nextIndex >= this.items.length) return false
    const [question] = this.items.splice(index, 1)
    this.items.splice(nextIndex, 0, question)
    return true
  }

  moveTo(id: string, targetId: string): boolean {
    const sourceIndex = this.items.findIndex((question) => question.id === id)
    const targetIndex = this.items.findIndex((question) => question.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return false
    const [question] = this.items.splice(sourceIndex, 1)
    this.items.splice(targetIndex, 0, question)
    return true
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
      this.setPause(pauseReason, result.session.targetPlatforms)
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
    this.setPause('user-stopped', this.activeTargetPlatforms)
    return true
  }

  pauseForDispatchFailure(taskId: string): boolean {
    if (this.activeTaskId !== taskId) return false
    const platforms = this.activeQueuedQuestion
      ? [...this.activeQueuedQuestion.targetPlatforms]
      : [...this.activeTargetPlatforms]
    if (this.activeQueuedQuestion) {
      this.items.unshift(copyQuestion(this.activeQueuedQuestion))
    }
    this.activeTaskId = null
    this.activeTargetPlatforms = []
    this.activeQueuedQuestion = null
    this.setPause('dispatch-failed', platforms)
    return true
  }

  markDispatchStarted(taskId: string): boolean {
    if (this.activeTaskId !== taskId || !this.activeQueuedQuestion) return false
    this.activeQueuedQuestion = null
    return true
  }

  pauseForTaskFailure(taskId: string): boolean {
    if (this.activeTaskId !== taskId) return false
    this.setPause('unknown-result', this.activeTargetPlatforms)
    this.activeTaskId = null
    this.activeTargetPlatforms = []
    this.activeQueuedQuestion = null
    return true
  }

  /**
   * 解除暂停并继续队列。仅在已暂停时生效。
   * 若仍在「观察期」内（requestObservation 设置的最早可恢复时间），直接返回 paused，不发送下一条。
   * 解除后若有待发送问题则按序派发下一条，否则回到 idle。
   */
  resume(now: number): QueueTransition {
    if (!this.pauseReason) return { kind: 'ignored' }
    if (this.resumeBlockedUntil !== null && now < this.resumeBlockedUntil) {
      return { kind: 'paused', reason: this.pauseReason }
    }
    this.pauseReason = null
    this.pausedTargetPlatforms = []
    this.resumeBlockedUntil = null
    const next = this.items.shift()
    if (!next) return { kind: 'idle' }
    this.activeTaskId = next.taskId
    this.activeTargetPlatforms = [...next.targetPlatforms]
    this.activeQueuedQuestion = copyQuestion(next)
    return { kind: 'dispatch', next: copyQuestion(next) }
  }

  /**
   * 增加一段「观察期」：在 now+ms 之前，resume 将被拒绝，保证观察期间不发送下一条。
   * 仅在已暂停时生效。
   */
  requestObservation(ms: number, now: number): boolean {
    if (!this.pauseReason) return false
    this.resumeBlockedUntil = now + ms
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
      pausedTargetPlatforms: [...this.pausedTargetPlatforms],
      resumeBlockedUntil: this.resumeBlockedUntil,
      items: this.items.map(copyQuestion),
    }
  }

  clear(): void {
    this.items = []
    this.activeTaskId = null
    this.activeTargetPlatforms = []
    this.activeQueuedQuestion = null
    this.pauseReason = null
    this.pausedTargetPlatforms = []
    this.resumeBlockedUntil = null
  }
}
