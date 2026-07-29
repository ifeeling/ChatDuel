import {
  MAX_PENDING_QUESTIONS,
  type PendingQuestion,
  type PendingQuestionMoveDirection,
  type PendingQuestionMutationResult,
  type PendingQuestionQueueSnapshot,
  type PendingQuestionUpdate,
} from '../lib/pending-question-queue'
import type { PreparedAttachment } from '../lib/file-handler'
import type { AIPlatform } from '../types'

export interface PendingQuestionQueueViewText {
  title(count: number, max: number): string
  position(index: number): string
  lifecycleNote: string
  waitingFor(labels: string): string
  paused(reason: string): string
  stopWaiting: string
  recheck: string
  observe: string
  resume: string
  historyUnsavedNote: string
  retrySave: string
  continueWithoutSave: string
  edit: string
  delete: string
  moveUp: string
  moveDown: string
  drag: string
  questionLabel: string
  targetsLabel: string
  save: string
  cancel: string
  emptyText: string
  noTargets: string
  editUnavailable: string
  attachmentLabel: string
  replaceAttachment: string
  removeAttachment: string
  emptyContent: string
  attachmentsTooLarge: string
}

export interface PendingQuestionEditorPlatform {
  key: AIPlatform
  label: string
}

export interface PendingQuestionQueueViewOptions {
  text: PendingQuestionQueueViewText
  platformLabel(platform: AIPlatform): string
  editablePlatforms: readonly PendingQuestionEditorPlatform[]
  canStop: boolean
  canResume: boolean
  formatAttachment(attachment: PreparedAttachment): string
  prepareAttachment(file: File): Promise<
    | { ok: true; attachment: PreparedAttachment }
    | { ok: false; message: string }
  >
  onSave(id: string, update: PendingQuestionUpdate): PendingQuestionMutationResult
  onDelete(id: string): void
  onMove(id: string, direction: PendingQuestionMoveDirection): void
  onMoveTo(id: string, targetId: string): void
  onRecheck(): void
  onObserve(): void
  onResume(): void
  onRetryHistorySave(): void
  onContinueWithoutSave(): void
}

function requiredElement<T extends HTMLElement>(container: HTMLElement, selector: string): T {
  const element = container.querySelector<T>(selector)
  if (!element) throw new Error(`Missing pending question queue element: ${selector}`)
  return element
}

function actionButton(
  label: string,
  className: string,
  visibleLabel: string,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = visibleLabel
  button.title = label
  button.setAttribute('aria-label', label)
  return button
}

export function renderPendingQuestionQueue(
  container: HTMLElement,
  snapshot: PendingQuestionQueueSnapshot,
  options: PendingQuestionQueueViewOptions,
): void {
  const visible = snapshot.items.length > 0
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

  const pauseActions = requiredElement(container, '#pending-question-pause-actions')
  pauseActions.replaceChildren()
  if (snapshot.status === 'paused') {
    if (snapshot.pauseReason === 'history-unsaved') {
      const note = document.createElement('p')
      note.className = 'pending-question-history-unsaved-note'
      note.textContent = options.text.historyUnsavedNote
      pauseActions.append(note)

      const retry = actionButton(options.text.retrySave, 'pending-question-retry-history', options.text.retrySave)
      retry.id = 'btn-retry-history-save'
      retry.addEventListener('click', () => options.onRetryHistorySave())
      pauseActions.append(retry)

      const skip = actionButton(options.text.continueWithoutSave, 'pending-question-continue-without-save', options.text.continueWithoutSave)
      skip.id = 'btn-continue-without-save'
      skip.addEventListener('click', () => options.onContinueWithoutSave())
      pauseActions.append(skip)
    } else {
      const recheck = actionButton(options.text.recheck, 'pending-question-recheck', options.text.recheck)
      recheck.id = 'btn-recheck'
      recheck.addEventListener('click', () => options.onRecheck())
      pauseActions.append(recheck)

      const observe = actionButton(options.text.observe, 'pending-question-observe', options.text.observe)
      observe.id = 'btn-observe'
      observe.addEventListener('click', () => options.onObserve())
      pauseActions.append(observe)

      const resume = actionButton(options.text.resume, 'pending-question-resume', options.text.resume)
      resume.id = 'btn-resume'
      resume.disabled = !options.canResume
      resume.addEventListener('click', () => options.onResume())
      pauseActions.append(resume)
    }
  }

  const list = requiredElement<HTMLOListElement>(container, '#pending-question-list')
  let activeEditorId: string | null = null

  const renderedItem = (question: PendingQuestion, index: number): HTMLLIElement => {
    const item = document.createElement('li')
    item.className = 'pending-question-item'
    item.dataset.questionId = question.id

    const position = document.createElement('span')
    position.className = 'pending-question-position'
    position.textContent = options.text.position(index + 1)

    const summary = document.createElement('span')
    summary.className = 'pending-question-summary'

    const questionText = document.createElement('span')
    questionText.className = 'pending-question-text'
    questionText.textContent = question.text

    const targets = document.createElement('span')
    targets.className = 'pending-question-targets'
    targets.textContent = question.targetPlatforms.map(options.platformLabel).join(' / ')

    summary.append(questionText, targets)
    if (question.attachment) {
      const attachment = document.createElement('span')
      attachment.className = 'pending-question-attachment'
      attachment.textContent = options.formatAttachment(question.attachment)
      summary.append(attachment)
    }

    const actions = document.createElement('span')
    actions.className = 'pending-question-actions'

    const drag = document.createElement('span')
    drag.className = 'pending-question-drag'
    drag.textContent = '⋮⋮'
    drag.draggable = true
    drag.title = options.text.drag
    drag.setAttribute('aria-label', options.text.drag)
    drag.setAttribute('role', 'img')
    const edit = actionButton(options.text.edit, 'pending-question-edit', '✎')
    const remove = actionButton(options.text.delete, 'pending-question-delete', '×')
    const moveUp = actionButton(options.text.moveUp, 'pending-question-move-up', '↑')
    const moveDown = actionButton(options.text.moveDown, 'pending-question-move-down', '↓')
    moveUp.disabled = index === 0
    moveDown.disabled = index === snapshot.items.length - 1

    drag.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/plain', question.id)
    })
    item.addEventListener('dragover', (event) => {
      event.preventDefault()
    })
    item.addEventListener('drop', (event) => {
      event.preventDefault()
      const sourceId = event.dataTransfer?.getData('text/plain')
      if (sourceId && sourceId !== question.id) {
        options.onMoveTo(sourceId, question.id)
      }
    })
    edit.addEventListener('click', () => {
      if (activeEditorId && activeEditorId !== question.id) {
        const previousIndex = snapshot.items.findIndex(({ id }) => id === activeEditorId)
        const previousQuestion = snapshot.items[previousIndex]
        const previousItem = [...list.children].find(
          (child) => (child as HTMLElement).dataset.questionId === activeEditorId,
        )
        if (previousQuestion && previousItem) {
          previousItem.replaceWith(renderedItem(previousQuestion, previousIndex))
        }
      }
      activeEditorId = question.id

      const editor = document.createElement('span')
      editor.className = 'pending-question-editor'

      const textarea = document.createElement('textarea')
      textarea.className = 'pending-question-edit-text'
      textarea.value = question.text
      textarea.setAttribute('aria-label', options.text.questionLabel)

      const targets = document.createElement('fieldset')
      targets.className = 'pending-question-edit-targets'
      const targetsLabel = document.createElement('legend')
      targetsLabel.textContent = options.text.targetsLabel
      targets.append(targetsLabel)

      const selectedTargets = new Set(question.targetPlatforms)
      const checkboxes = options.editablePlatforms.map(({ key, label }) => {
        const target = document.createElement('label')
        target.className = 'pending-question-edit-target'
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.value = key
        input.checked = selectedTargets.has(key)
        target.append(input, document.createTextNode(label))
        targets.append(target)
        return { key, input }
      })

      const error = document.createElement('span')
      error.className = 'pending-question-edit-error'
      error.setAttribute('role', 'alert')

      const editorActions = document.createElement('span')
      editorActions.className = 'pending-question-editor-actions'
      const save = actionButton(options.text.save, 'pending-question-save', options.text.save)
      const cancel = actionButton(
        options.text.cancel,
        'pending-question-cancel',
        options.text.cancel,
      )
      editorActions.append(save, cancel)

      let attachmentDraft = question.attachment ?? null
      const attachmentEditor = document.createElement('span')
      attachmentEditor.className = 'pending-question-edit-attachments'
      const attachmentSummary = document.createElement('span')
      attachmentSummary.className = 'pending-question-edit-attachment'
      const updateAttachmentSummary = () => {
        attachmentSummary.textContent = attachmentDraft
          ? options.formatAttachment(attachmentDraft)
          : options.text.attachmentLabel
      }
      updateAttachmentSummary()
      const attachmentInput = document.createElement('input')
      attachmentInput.type = 'file'
      attachmentInput.className = 'pending-question-attachment-input'
      attachmentInput.hidden = true
      const replaceAttachment = actionButton(
        options.text.replaceAttachment,
        'pending-question-replace-attachment',
        options.text.replaceAttachment,
      )
      const removeAttachment = actionButton(
        options.text.removeAttachment,
        'pending-question-remove-attachment',
        options.text.removeAttachment,
      )
      removeAttachment.disabled = !attachmentDraft
      replaceAttachment.addEventListener('click', () => attachmentInput.click())
      removeAttachment.addEventListener('click', () => {
        attachmentDraft = null
        removeAttachment.disabled = true
        error.textContent = ''
        updateAttachmentSummary()
      })
      attachmentInput.addEventListener('change', async () => {
        const file = attachmentInput.files?.[0]
        if (!file) return
        save.disabled = true
        const result = await options.prepareAttachment(file)
        save.disabled = false
        if (!result.ok) {
          error.textContent = result.message
          return
        }
        attachmentDraft = result.attachment
        removeAttachment.disabled = false
        error.textContent = ''
        updateAttachmentSummary()
      })
      attachmentEditor.append(
        attachmentSummary,
        replaceAttachment,
        removeAttachment,
        attachmentInput,
      )

      cancel.addEventListener('click', () => {
        activeEditorId = null
        item.replaceWith(renderedItem(question, index))
      })
      save.addEventListener('click', () => {
        const text = textarea.value.trim()
        if (!text && !attachmentDraft) {
          error.textContent = options.text.emptyContent
          return
        }
        const targetPlatforms = checkboxes
          .filter(({ input }) => input.checked)
          .map(({ key }) => key)
        if (targetPlatforms.length === 0) {
          error.textContent = options.text.noTargets
          return
        }
        const result = options.onSave(question.id, {
          text,
          targetPlatforms,
          attachment: attachmentDraft,
        })
        if (!result.ok) {
          error.textContent = result.reason === 'attachments-too-large'
            ? options.text.attachmentsTooLarge
            : result.reason === 'empty'
              ? options.text.emptyContent
              : result.reason === 'no-targets'
                ? options.text.noTargets
                : options.text.editUnavailable
          return
        }
        activeEditorId = null
        item.replaceWith(renderedItem({
          ...question,
          text,
          targetPlatforms,
          attachment: attachmentDraft,
        }, index))
      })

      editor.append(editorActions, textarea, targets, attachmentEditor, error)
      item.replaceChildren(editor)
      textarea.focus()
    })
    remove.addEventListener('click', () => options.onDelete(question.id))
    moveUp.addEventListener('click', () => options.onMove(question.id, 'up'))
    moveDown.addEventListener('click', () => options.onMove(question.id, 'down'))

    actions.append(drag, edit, remove, moveUp, moveDown)
    item.append(position, summary, actions)
    return item
  }

  list.replaceChildren(...snapshot.items.map(renderedItem))
}
