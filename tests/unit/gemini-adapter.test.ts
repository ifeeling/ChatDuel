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

  it('captures Gemini responses with paragraph, heading, and list structure', async () => {
    document.body.innerHTML = `
      <message-content>
        <model-response>
          <p><strong>要点概括：</strong></p>
          <p>这是 Cursor 的官方图标。</p>
          <h2>详细说明</h2>
          <ul>
            <li><strong>应用名称：</strong>Cursor</li>
            <li><strong>主要功能：</strong>AI 代码编辑器。</li>
          </ul>
        </model-response>
      </message-content>
    `

    await expect(createGeminiAdapter().getLastResponse()).resolves.toBe([
      '要点概括：',
      '',
      '这是 Cursor 的官方图标。',
      '',
      '## 详细说明',
      '',
      '- 应用名称：Cursor',
      '- 主要功能：AI 代码编辑器。',
    ].join('\n'))
  })
})
