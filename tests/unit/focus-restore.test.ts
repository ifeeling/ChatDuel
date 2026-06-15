import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindComposerFocusRestorer } from '../../src/lib/focus-restore'

describe('composer focus restore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <footer class="composer">
        <textarea id="input"></textarea>
      </footer>
      <iframe class="panel-iframe"></iframe>
    `
  })

  it('restores focus to the shared composer when the window regains focus', () => {
    const input = document.querySelector<HTMLTextAreaElement>('#input')!
    const composer = document.querySelector<HTMLElement>('.composer')!
    const dispose = bindComposerFocusRestorer({ input, composer, restoreDelayMs: 10 })

    input.focus()
    window.dispatchEvent(new Event('blur'))
    input.blur()
    window.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(10)

    expect(document.activeElement).toBe(input)
    dispose()
  })

  it('does not steal focus when the shared composer was not active before blur', () => {
    const input = document.querySelector<HTMLTextAreaElement>('#input')!
    const composer = document.querySelector<HTMLElement>('.composer')!
    const frame = document.querySelector<HTMLIFrameElement>('.panel-iframe')!
    const dispose = bindComposerFocusRestorer({ input, composer, restoreDelayMs: 10 })

    frame.focus()
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(10)

    expect(document.activeElement).not.toBe(input)
    dispose()
  })

  it('does not restore focus while a dialog is open', () => {
    const input = document.querySelector<HTMLTextAreaElement>('#input')!
    const composer = document.querySelector<HTMLElement>('.composer')!
    const dispose = bindComposerFocusRestorer({
      input,
      composer,
      restoreDelayMs: 10,
      isBlocked: () => true,
    })

    input.focus()
    window.dispatchEvent(new Event('blur'))
    input.blur()
    window.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(10)

    expect(document.activeElement).not.toBe(input)
    dispose()
  })
})
