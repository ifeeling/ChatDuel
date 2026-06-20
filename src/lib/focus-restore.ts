interface ComposerFocusRestorerOptions {
  input: HTMLTextAreaElement
  composer: HTMLElement
  isBlocked?: () => boolean
  restoreDelayMs?: number
  doc?: Document
  win?: Window
}

export function bindComposerFocusRestorer(options: ComposerFocusRestorerOptions): () => void {
  const {
    input,
    composer,
    isBlocked = () => false,
    restoreDelayMs = 60,
    doc = document,
    win = window,
  } = options

  let shouldRestoreOnFocus = false
  let restoreTimer: ReturnType<typeof setTimeout> | null = null

  const composerHasFocus = () => {
    const active = doc.activeElement
    return active === input || (active instanceof Node && composer.contains(active))
  }

  const aiFrameHasFocus = () => {
    const active = doc.activeElement
    return active instanceof HTMLIFrameElement && active.classList.contains('panel-iframe')
  }

  const clearRestoreTimer = () => {
    if (!restoreTimer) return
    clearTimeout(restoreTimer)
    restoreTimer = null
  }

  const onInputFocus = () => {
    shouldRestoreOnFocus = true
  }

  const onDocumentPointerDown = (event: Event) => {
    const target = event.target
    shouldRestoreOnFocus = target instanceof Node && composer.contains(target)
  }

  const onWindowBlur = () => {
    shouldRestoreOnFocus = shouldRestoreOnFocus && composerHasFocus()
  }

  const onWindowFocus = () => {
    if (!shouldRestoreOnFocus || isBlocked() || aiFrameHasFocus()) return
    clearRestoreTimer()
    restoreTimer = setTimeout(() => {
      restoreTimer = null
      if (shouldRestoreOnFocus && !isBlocked() && !aiFrameHasFocus()) input.focus()
    }, restoreDelayMs)
  }

  input.addEventListener('focus', onInputFocus)
  doc.addEventListener('pointerdown', onDocumentPointerDown, true)
  win.addEventListener('blur', onWindowBlur)
  win.addEventListener('focus', onWindowFocus)

  return () => {
    clearRestoreTimer()
    input.removeEventListener('focus', onInputFocus)
    doc.removeEventListener('pointerdown', onDocumentPointerDown, true)
    win.removeEventListener('blur', onWindowBlur)
    win.removeEventListener('focus', onWindowFocus)
  }
}
