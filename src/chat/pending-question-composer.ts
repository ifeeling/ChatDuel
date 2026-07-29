import {
  type PendingQuestion,
  type PendingQuestionDraft,
  type PendingQuestionMutationResult,
  type PendingQuestionUpdate,
  PendingQuestionQueue,
} from '../lib/pending-question-queue'
import type { PreparedAttachment } from '../lib/file-handler'
import type { AIPlatform } from '../types'

type ComposerQuestionDraft = Omit<PendingQuestionDraft, 'text'>

export function enqueuePendingQuestionFromComposer(
  queue: PendingQuestionQueue,
  textarea: HTMLTextAreaElement,
  draft: ComposerQuestionDraft,
): ReturnType<PendingQuestionQueue['enqueue']> {
  const result = queue.enqueue({
    ...draft,
    text: textarea.value,
  })
  if (result.ok) textarea.value = ''
  return result
}

export interface QueuedQuestionDispatchInput {
  text: string
  targets: AIPlatform[]
  attachment: PreparedAttachment | null
  clearComposerOnSendComplete: false
  taskAlreadyStarted: true
  sessionId: string
  taskId: string
}

export async function dispatchPendingQuestion(
  queue: PendingQuestionQueue,
  question: PendingQuestion,
  dispatch: (input: QueuedQuestionDispatchInput) => Promise<boolean>,
): Promise<void> {
  try {
    const started = await dispatch({
      text: question.text,
      targets: [...question.targetPlatforms],
      attachment: question.attachment ?? null,
      clearComposerOnSendComplete: false,
      taskAlreadyStarted: true,
      sessionId: question.id,
      taskId: question.taskId,
    })
    if (!started) throw new Error('Queued question dispatch did not start')
    queue.markDispatchStarted(question.taskId)
  } catch (error) {
    queue.pauseForDispatchFailure(question.taskId)
    throw error
  }
}

export function updatePendingQuestionFromView(
  queue: PendingQuestionQueue,
  id: string,
  update: PendingQuestionUpdate,
  redraw: () => void,
): PendingQuestionMutationResult {
  const result = queue.update(id, update)
  if (result.ok) redraw()
  return result
}

export function bindPendingQuestionPageLifecycle(
  queue: PendingQuestionQueue,
  target: EventTarget,
): () => void {
  const clearQueue = () => queue.clear()
  target.addEventListener('beforeunload', clearQueue)
  return () => target.removeEventListener('beforeunload', clearQueue)
}

export function stopPendingQuestionWaiting(
  queue: PendingQuestionQueue,
  controller: AbortController | null,
): boolean {
  const taskId = queue.snapshot().activeTaskId
  if (!taskId || !queue.pauseForUserStop(taskId)) return false
  controller?.abort()
  return true
}
