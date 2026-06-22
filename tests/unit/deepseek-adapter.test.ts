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

  it('includes continuation text outside DeepSeek inner markdown blocks', async () => {
    document.body.innerHTML = `
      <main>
        <div class="message user">你们好</div>
        <section class="ds-turn">
          <div class="markdown">
            <p>你好！很高兴见到你！😊</p>
            <p>我是DeepSeek，一个乐于助人的AI助手。无论你是想聊天、问问题、寻求建议，还是需要帮忙解决某个具体问题，我都非常乐意为你提供帮助。</p>
          </div>
          <p>今天有什么我可以为你做的呢？请随时告诉我！✨</p>
          <div class="actions"><button>复制</button><button>重新生成</button></div>
        </section>
      </main>
      <textarea placeholder="给 DeepSeek 发送消息"></textarea>
    `

    await expect(createDeepSeekAdapter().getLastResponse()).resolves.toBe([
      '你好！很高兴见到你！😊',
      '',
      '我是DeepSeek，一个乐于助人的AI助手。无论你是想聊天、问问题、寻求建议，还是需要帮忙解决某个具体问题，我都非常乐意为你提供帮助。',
      '',
      '今天有什么我可以为你做的呢？请随时告诉我！✨',
    ].join('\n'))
  })

  it('expands from a middle DeepSeek response fragment to the surrounding answer block', async () => {
    document.body.innerHTML = `
      <main>
        <section class="ds-turn">
          <p>你好呀！😊 很高兴见到你！</p>
          <p class="answer">我是DeepSeek，你的AI助手，随时准备帮你解答问题。</p>
          <p>今天有什么我可以帮你的吗？尽管说，别客气～</p>
          <div class="actions"><button>复制</button></div>
        </section>
      </main>
      <textarea placeholder="给 DeepSeek 发送消息"></textarea>
    `

    await expect(createDeepSeekAdapter().getLastResponse()).resolves.toBe([
      '你好呀！😊 很高兴见到你！',
      '',
      '我是DeepSeek，你的AI助手，随时准备帮你解答问题。',
      '',
      '今天有什么我可以帮你的吗？尽管说，别客气～',
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
    vi.useFakeTimers()
    document.body.innerHTML = '<div class="composer"><input type="file" accept="image/*"><textarea placeholder="给 DeepSeek 发送消息"></textarea></div>'
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const changeSpy = vi.fn(() => {
      const preview = document.createElement('img')
      preview.className = 'upload-preview'
      document.querySelector('.composer')?.appendChild(preview)
    })
    input.addEventListener('change', changeSpy)

    const file = new File(['image'], 'cursor.png', { type: 'image/png' })
    try {
      const upload = createDeepSeekAdapter().attachImage(file)
      await vi.advanceTimersByTimeAsync(3100)
      await upload

      expect(input.files?.[0]?.name).toBe('cursor.png')
      expect(changeSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prefers paste into the DeepSeek composer when paste creates attachment evidence', async () => {
    document.body.innerHTML = `
      <div class="composer">
        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt">
        <textarea placeholder="给 DeepSeek 发送消息"></textarea>
      </div>
    `
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!
    const changeSpy = vi.fn()
    const pasteSpy = vi.fn(() => {
      const preview = document.createElement('span')
      preview.className = 'upload-file'
      preview.textContent = 'cursor.png'
      document.querySelector('.composer')?.appendChild(preview)
    })
    input.addEventListener('change', changeSpy)
    textarea.addEventListener('paste', pasteSpy)

    const file = new File(['image'], 'cursor.png', { type: 'image/png' })
    await createDeepSeekAdapter().attachImage(file)

    expect(pasteSpy).toHaveBeenCalledTimes(1)
    expect(changeSpy).not.toHaveBeenCalled()
  })

  it('uses paste/drop when the DeepSeek composer creates attachment evidence', async () => {
    document.body.innerHTML = `
      <div class="composer">
        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt">
        <textarea placeholder="给 DeepSeek 发送消息"></textarea>
      </div>
    `
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!
    const pasteSpy = vi.fn(() => {
      const preview = document.createElement('span')
      preview.className = 'upload-file'
      preview.textContent = 'cursor.png'
      document.querySelector('.composer')?.appendChild(preview)
    })
    textarea.addEventListener('paste', pasteSpy)

    const file = new File(['image'], 'cursor.png', { type: 'image/png' })
    await createDeepSeekAdapter().attachImage(file)

    expect(pasteSpy).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.upload-file')?.textContent).toBe('cursor.png')
  })

  it('ignores unrelated page media when checking DeepSeek attachment evidence', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div id="outside"></div>
      <div class="composer">
        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt">
        <textarea placeholder="给 DeepSeek 发送消息"></textarea>
      </div>
    `
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!
    input.addEventListener('change', () => {
      const unrelated = document.createElement('img')
      unrelated.className = 'upload-icon'
      document.querySelector('#outside')?.appendChild(unrelated)
    })
    const pasteSpy = vi.fn()
    textarea.addEventListener('paste', pasteSpy)

    try {
      const file = new File(['image'], 'cursor.png', { type: 'image/png' })
      const upload = createDeepSeekAdapter().attachImage(file)
      const expectedFailure = expect(upload).rejects.toThrow('deepseek image upload failed')
      await vi.advanceTimersByTimeAsync(6200)

      expect(pasteSpy).toHaveBeenCalledTimes(1)
      await expectedFailure
    } finally {
      vi.useRealTimers()
    }
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
