import {
  type PendingQuestion,
  type PendingQuestionDraft,
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
  dispatch: (input: QueuedQuestionDispatchInput) => Promise<void>,
): Promise<void> {
  try {
    await dispatch({
      text: question.text,
      targets: [...question.targetPlatforms],
      attachment: question.attachment,
      clearComposerOnSendComplete: false,
      taskAlreadyStarted: true,
      sessionId: question.id,
      taskId: question.taskId,
    })
    queue.markDispatchStarted(question.taskId)
  } catch (error) {
    queue.pauseForDispatchFailure(question.taskId)
    throw error
  }
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
