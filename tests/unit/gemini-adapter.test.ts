import { beforeEach, describe, expect, it } from 'vitest'
import { createGeminiAdapter } from '../../src/adapters/gemini/adapter'

describe('gemini adapter', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('retries Enter when the first submit leaves the message in the editor', async () => {
    document.body.innerHTML = '<div class="ql-editor" contenteditable="true"></div>'

    const editor = document.querySelector<HTMLElement>('.ql-editor')!
    let keydowns = 0
    editor.addEventListener('keydown', () => {
      keydowns += 1
      if (keydowns === 2) editor.innerHTML = '<p><br></p>'
    })

    await createGeminiAdapter().sendMessage('这是什么?')

    expect(keydowns).toBe(2)
  })
})
