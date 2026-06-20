import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeepSeekAdapter } from '../../src/adapters/deepseek/adapter'

beforeAll(() => {
  if (typeof globalThis.DataTransfer === 'undefined') {
    class DT {
      items: { add: (f: File) => void }
      files: File[]
      constructor() {
        const files: File[] = []
        this.files = files
        this.items = {
          add: (f: File) => {
            files.push(f)
          },
        }
      }
    }
    ;(globalThis as unknown as { DataTransfer: typeof DataTransfer }).DataTransfer = DT as unknown as typeof DataTransfer
  }
})

describe('deepseek adapter', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('captures the full latest assistant block instead of the last paragraph only', async () => {
    document.body.innerHTML = `
      <main>
        <div class="message user">你们好</div>
        <div class="message assistant">
          <p>你好！ 😊 很高兴见到你！</p>
          <p>我是DeepSeek，一个由深度求索公司打造的AI助手。</p>
          <p>请随意告诉我你的需求，我们一起开始吧～ ✨</p>
          <button>复制</button>
          <button>重新生成</button>
        </div>
        <div class="message user">这是什么图?</div>
      </main>
      <textarea placeholder="给 DeepSeek 发送消息"></textarea>
    `

    await expect(createDeepSeekAdapter().getLastResponse()).resolves.toBe([
      '你好！ 😊 很高兴见到你！',
      '',
      '我是DeepSeek，一个由深度求索公司打造的AI助手。',
      '',
      '请随意告诉我你的需求，我们一起开始吧～ ✨',
    ].join('\n'))
  })

  it('preserves headings and ordered lists in DeepSeek responses', async () => {
    document.body.innerHTML = `
      <main>
        <div class="message assistant">
          <p>不过别担心，你可以这样帮我“看到”它：</p>
          <ol>
            <li><strong>描述一下</strong>：告诉我图片里有什么</li>
            <li><strong>提供文字信息</strong>：如果图里有文字，你可以打出来</li>
          </ol>
        </div>
      </main>
      <textarea placeholder="给 DeepSeek 发送消息"></textarea>
    `

    await expect(createDeepSeekAdapter().getLastResponse()).resolves.toBe([
      '不过别担心，你可以这样帮我“看到”它：',
      '',
      '1. 描述一下：告诉我图片里有什么',
      '2. 提供文字信息：如果图里有文字，你可以打出来',
    ].join('\n'))
  })

  it('attaches an image through an explicit DeepSeek file input', async () => {
    document.body.innerHTML = '<input type="file" accept="image/*"><textarea placeholder="给 DeepSeek 发送消息"></textarea>'
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const changeSpy = vi.fn()
    input.addEventListener('change', changeSpy)

    const file = new File(['image'], 'cursor.png', { type: 'image/png' })
    await createDeepSeekAdapter().attachImage(file)

    expect(input.files?.[0]?.name).toBe('cursor.png')
    expect(changeSpy).toHaveBeenCalledTimes(1)
  })

  it('fires input and change events and waits for attachment evidence before resolving', async () => {
    document.body.innerHTML = `
      <div class="composer">
        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt">
        <textarea placeholder="给 DeepSeek 发送消息"></textarea>
      </div>
    `
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const inputSpy = vi.fn()
    const changeSpy = vi.fn(() => {
      const preview = document.createElement('span')
      preview.className = 'upload-file'
      preview.textContent = 'cursor.png'
      document.querySelector('.composer')?.appendChild(preview)
    })
    input.addEventListener('input', inputSpy)
    input.addEventListener('change', changeSpy)

    const file = new File(['image'], 'cursor.png', { type: 'image/png' })
    await createDeepSeekAdapter().attachImage(file)

    expect(inputSpy).toHaveBeenCalledTimes(1)
    expect(changeSpy).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.upload-file')?.textContent).toBe('cursor.png')
  })
})
