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
    button.addEventListener('click', clickSpy)

    await createCopilotAdapter().sendMessage('你好 Copilot')

    expect(textarea.value).toBe('你好 Copilot')
    expect(clickSpy).toHaveBeenCalledTimes(1)
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
})
