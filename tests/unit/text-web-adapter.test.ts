import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCopilotAdapter } from '../../src/adapters/copilot/adapter'
import { createGrokAdapter } from '../../src/adapters/grok/adapter'

describe('text web adapter', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('writes textarea text and clicks the send button for Copilot', async () => {
    document.body.innerHTML = `
      <main>
        <textarea placeholder="Message Copilot"></textarea>
        <button aria-label="Send">Send</button>
      </main>
    `

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!
    const button = document.querySelector<HTMLButtonElement>('button')!
    const clickSpy = vi.fn()
    button.addEventListener('click', () => {
      clickSpy()
      textarea.value = ''
    })

    await createCopilotAdapter().sendMessage('你好 Copilot')

    expect(textarea.value).toBe('')
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('removes Copilot speaker labels from captured history text', async () => {
    document.body.innerHTML = `
      <main>
        <section data-testid="message">
          <h6>Copilot</h6>
          <span>said</span>
          <div>下午好，cong。</div>
          <p>我在呢，很高兴听到你的声音。</p>
        </section>
        <textarea placeholder="Message Copilot"></textarea>
      </main>
    `

    await expect(createCopilotAdapter().getLastResponse()).resolves.toBe([
      '下午好，cong。',
      '',
      '我在呢，很高兴听到你的声音。',
    ].join('\n'))
  })

  it('writes contenteditable text and reads the latest Grok response', async () => {
    document.body.innerHTML = `
      <main>
        <div role="textbox" contenteditable="true"></div>
        <button aria-label="Send">Send</button>
        <article>旧回答</article>
        <article><p>新回答</p><ul><li>保留格式</li></ul></article>
      </main>
    `

    await createGrokAdapter().writeText('你好 Grok')

    expect(document.querySelector<HTMLElement>('[role="textbox"]')?.textContent).toBe('你好 Grok')
    await expect(createGrokAdapter().getLastResponse()).resolves.toBe('新回答\n\n- 保留格式')
  })

  it('uses browser text insertion for Grok contenteditable composers', async () => {
    document.body.innerHTML = `
      <main>
        <div role="textbox" contenteditable="true"></div>
        <button aria-label="Send">Send</button>
      </main>
    `
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn((command: string, _ui?: boolean, value?: string) => {
        if (command === 'insertText') {
          document.querySelector<HTMLElement>('[role="textbox"]')!.textContent = String(value)
          return true
        }
        return false
      }),
    })
    const execSpy = vi.mocked(document.execCommand)

    await createGrokAdapter().writeText('你好 Grok')

    expect(execSpy).toHaveBeenCalledWith('insertText', false, '你好 Grok')
    expect(document.querySelector<HTMLElement>('[role="textbox"]')?.textContent).toBe('你好 Grok')
  })

  it('dispatches change after writing Grok contenteditable composers', async () => {
    document.body.innerHTML = `
      <main>
        <div role="textbox" contenteditable="true"></div>
        <button aria-label="Send">Send</button>
      </main>
    `
    const box = document.querySelector<HTMLElement>('[role="textbox"]')!
    const changeSpy = vi.fn()
    box.addEventListener('change', changeSpy)

    await createGrokAdapter().writeText('你好 Grok')

    expect(changeSpy).toHaveBeenCalledTimes(1)
  })

  it('uses the Grok submit button instead of unrelated buttons', async () => {
    document.body.innerHTML = `
      <main>
        <textarea aria-label="Ask Grok anything"></textarea>
        <button type="button" aria-label="Attach">Attach</button>
        <button type="submit">Send</button>
      </main>
    `
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!
    const attach = document.querySelector<HTMLButtonElement>('button[type="button"]')!
    const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]')!
    const attachSpy = vi.fn()
    const submitSpy = vi.fn()
    attach.addEventListener('click', attachSpy)
    submit.addEventListener('click', () => {
      submitSpy()
      textarea.value = ''
    })

    await createGrokAdapter().sendMessage('你好 Grok')

    expect(attachSpy).not.toHaveBeenCalled()
    expect(submitSpy).toHaveBeenCalledTimes(1)
  })

  it('does not report success when the composer still contains the unsent Grok prompt', async () => {
    document.body.innerHTML = `
      <main>
        <div role="textbox" contenteditable="true"></div>
        <button aria-label="Send">Send</button>
      </main>
    `

    await expect(createGrokAdapter().sendMessage('没有真的发出去')).rejects.toThrow(/发送后没有确认/)
  })
})
