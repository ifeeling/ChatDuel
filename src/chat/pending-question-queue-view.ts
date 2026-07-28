import { MAX_PENDING_QUESTIONS, type PendingQuestionQueueSnapshot } from '../lib/pending-question-queue'
import type { AIPlatform } from '../types'

export interface PendingQuestionQueueViewText {
  title(count: number, max: number): string
  lifecycleNote: string
  waitingFor(labels: string): string
  paused(reason: string): string
  stopWaiting: string
}

export interface PendingQuestionQueueViewOptions {
  text: PendingQuestionQueueViewText
  platformLabel(platform: AIPlatform): string
  canStop: boolean
}

function requiredElement<T extends HTMLElement>(container: HTMLElement, selector: string): T {
  const element = container.querySelector<T>(selector)
  if (!element) throw new Error(`Missing pending question queue element: ${selector}`)
  return element
}

export function renderPendingQuestionQueue(
  container: HTMLElement,
  snapshot: PendingQuestionQueueSnapshot,
  options: PendingQuestionQueueViewOptions,
): void {
  const visible = snapshot.status !== 'idle'
    || snapshot.activeTaskId !== null
    || snapshot.items.length > 0
  container.hidden = !visible
  if (!visible) return

  requiredElement(container, '#pending-question-title').textContent = options.text.title(
    snapshot.items.length,
    MAX_PENDING_QUESTIONS,
  )
  requiredElement(container, '#pending-question-lifecycle-note').textContent =
    options.text.lifecycleNote

  const stopButton = requiredElement<HTMLButtonElement>(container, '#btn-stop-waiting')
  stopButton.textContent = options.text.stopWaiting
  stopButton.hidden = !options.canStop
    || snapshot.activeTaskId === null
    || snapshot.status === 'paused'

  const status = requiredElement(container, '#pending-question-status')
  if (snapshot.pauseReason) {
    status.textContent = options.text.paused(snapshot.pauseReason)
  } else if (snapshot.activeTargetPlatforms.length > 0) {
    const labels = snapshot.activeTargetPlatforms.map(options.platformLabel).join(' / ')
    status.textContent = options.text.waitingFor(labels)
  } else {
    status.textContent = ''
  }

  const list = requiredElement<HTMLOListElement>(container, '#pending-question-list')
  list.replaceChildren(...snapshot.items.map((question) => {
    const item = document.createElement('li')
    item.className = 'pending-question-item'

    const questionText = document.createElement('span')
    questionText.className = 'pending-question-text'
    questionText.textContent = question.text

    const targets = document.createElement('span')
    targets.className = 'pending-question-targets'
    targets.textContent = question.targetPlatforms.map(options.platformLabel).join(' / ')

    item.append(questionText, targets)
    return item
  }))
}
