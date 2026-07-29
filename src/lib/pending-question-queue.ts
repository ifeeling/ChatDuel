import type {
  AnswerCollectionPlatformResult,
  AnswerCollectionTaskResult,
} from './answer-collection-task'
import type { AIPlatform } from '../types'
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

  markDispatchStarted(taskId: string): boolean {
    if (this.activeTaskId !== taskId || !this.activeQueuedQuestion) return false
    this.activeQueuedQuestion = null
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

  clear(): void {
    this.items = []
    this.activeTaskId = null
    this.activeTargetPlatforms = []
    this.activeQueuedQuestion = null
    this.pauseReason = null
  }
}
