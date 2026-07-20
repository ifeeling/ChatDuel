import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createChatGPTAdapter } from '../../src/adapters/chatgpt/adapter'
import type { AdapterDiagnostics } from '../../src/adapters/base'

function diagnostics() {
  const emit = vi.fn()
  return {
    emit,
    value: { reporter: { emit }, selectorConfigVersion: '2026.06' } satisfies AdapterDiagnostics,
  }
}

describe('chatgpt adapter', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('retries sending when the first click leaves the message in the composer', async () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">send</button>
    `

    const box = document.querySelector<HTMLElement>('#prompt-textarea')!
    const btn = document.querySelector<HTMLButtonElement>("button[data-testid='send-button']")!
    let clicks = 0
    btn.addEventListener('click', () => {
      clicks += 1
      if (clicks === 2) box.textContent = ''
    })

    const trace = diagnostics()
    await createChatGPTAdapter().sendMessage('这是什么?', undefined, trace.value)

    expect(clicks).toBe(2)
    expect(trace.emit).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'send-click',
      retryNumber: 1,
    }))
    expect(trace.emit).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'send-click',
      retryNumber: 2,
    }))
    expect(trace.emit).toHaveBeenLastCalledWith(expect.objectContaining({
      operation: 'send-ack',
      stage: 'accepted',
      retryCount: 2,
    }))
    expect(trace.emit.mock.calls.some(([event]) => event.runOutcome !== undefined)).toBe(false)
  })

  it('records a stable terminal error when the input box is missing', async () => {
    const trace = diagnostics()

    await expect(createChatGPTAdapter().sendMessage('PRIVATE_PROMPT', undefined, trace.value))
      .rejects.toThrow('input box not found')

    expect(trace.emit).toHaveBeenLastCalledWith(expect.objectContaining({
      operation: 'input-locate',
      eventStatus: 'failed',
      runOutcome: 'failed',
      errorCode: 'input-box-not-found',
      inputCharacterCount: 14,
      selectorConfigVersion: '2026.06',
    }))
    expect(JSON.stringify(trace.emit.mock.calls)).not.toContain('PRIVATE_PROMPT')
  })

  it('waits for the send button to become enabled before clicking', async () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true">这是什么?</div>
      <button data-testid="send-button" disabled>send</button>
    `

    const btn = document.querySelector<HTMLButtonElement>("button[data-testid='send-button']")!
    const clickSpy = vi.fn()
    btn.addEventListener('click', clickSpy)

    const send = createChatGPTAdapter().triggerSend()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(clickSpy).not.toHaveBeenCalled()

    btn.disabled = false
    await send

    expect(clickSpy).toHaveBeenCalledTimes(1)
  })
})
