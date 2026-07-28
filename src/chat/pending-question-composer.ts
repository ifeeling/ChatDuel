import {
  type PendingQuestionDraft,
  PendingQuestionQueue,
} from '../lib/pending-question-queue'

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

export function stopPendingQuestionWaiting(
  queue: PendingQuestionQueue,
  controller: AbortController | null,
): boolean {
  const taskId = queue.snapshot().activeTaskId
  if (!taskId || !queue.pauseForUserStop(taskId)) return false
  controller?.abort()
  return true
}
