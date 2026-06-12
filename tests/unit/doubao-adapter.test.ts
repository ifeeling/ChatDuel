import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDoubaoAdapter } from '../../src/adapters/doubao/adapter'

describe('doubao adapter', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('writes text into the visible composer textarea', async () => {
    document.body.innerHTML = '<textarea placeholder="发消息..."></textarea>'

    const inputSpy = vi.fn()
    document.querySelector('textarea')!.addEventListener('input', inputSpy)

    await createDoubaoAdapter().writeText('你好\n豆包')

    expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('你好\n豆包')
    expect(inputSpy).toHaveBeenCalledTimes(1)
  })

  it('clicks the send button when triggering send', async () => {
    document.body.innerHTML = '<button aria-label="发送">send</button>'

    const clickSpy = vi.fn()
    document.querySelector('button')!.addEventListener('click', clickSpy)

    await createDoubaoAdapter().triggerSend()

    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back to the last button near the composer when send icon has no label', async () => {
    document.body.innerHTML = `
      <section>
        <div class="composer">
          <button>+</button>
          <textarea placeholder="发消息或按住空格说话...">你好</textarea>
          <button class="voice"></button>
          <button class="send"></button>
        </div>
      </section>
    `

    const buttons = document.querySelectorAll('button')
    const voiceSpy = vi.fn()
    const sendSpy = vi.fn()
    buttons[1].addEventListener('click', voiceSpy)
    buttons[2].addEventListener('click', sendSpy)

    await createDoubaoAdapter().triggerSend()

    expect(voiceSpy).not.toHaveBeenCalled()
    expect(sendSpy).toHaveBeenCalledTimes(1)
  })

  it('can activate a role=button send icon near the composer', async () => {
    document.body.innerHTML = `
      <div class="composer">
        <textarea placeholder="发消息或按住空格说话...">你好</textarea>
        <div role="button" class="send-icon"></div>
      </div>
    `

    const clickSpy = vi.fn()
    document.querySelector('[role="button"]')!.addEventListener('click', clickSpy)

    await createDoubaoAdapter().triggerSend()

    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('dispatches Enter on the composer when no send control is discoverable', async () => {
    document.body.innerHTML = '<textarea placeholder="发消息或按住空格说话...">你好</textarea>'

    const keySpy = vi.fn()
    document.querySelector('textarea')!.addEventListener('keydown', keySpy)

    await createDoubaoAdapter().triggerSend()

    expect(keySpy).toHaveBeenCalledTimes(1)
    expect(keySpy.mock.calls[0][0]).toMatchObject({ key: 'Enter', code: 'Enter' })
  })
})
