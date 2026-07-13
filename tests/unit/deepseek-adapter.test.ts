import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeepSeekAdapter, ensureDeepSeekVisionMode } from '../../src/adapters/deepseek/adapter'

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
    localStorage.clear()
    vi.restoreAllMocks()
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

  it('reports streaming while DeepSeek shows a stop generating button', async () => {
    document.body.innerHTML = `
      <main>
        <div class="message user">世界杯的情况</div>
        <div class="message assistant">
          <p>目前世界杯正在进行中。</p>
        </div>
      </main>
      <textarea placeholder="给 DeepSeek 发送消息"></textarea>
      <button aria-label="停止生成"><svg></svg></button>
    `

    await expect(createDeepSeekAdapter().getConversationState()).resolves.toMatchObject({
      status: 'streaming',
      lastResponse: '目前世界杯正在进行中。',
    })
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

  it('captures the whole DeepSeek answer instead of a later score fragment', async () => {
    document.body.innerHTML = `
      <main>
        <div class="message user">昨天世界杯战况如何?</div>
        <section class="ds-turn">
          <div class="answer-content">
            <p>昨天（2026年6月21日）进行了几场世界杯小组赛第二轮的比赛，多场对决都踢得相当激烈。</p>
            <p>我把具体赛果整理了一下：</p>
            <div class="score-table">
              <div class="score-row">
                <span>E组</span>
                <span>德国 vs 特拉迪瓦</span>
                <span>2-1</span>
              </div>
              <div class="score-row">
                <span>F组</span>
                <span>荷兰 vs 瑞典</span>
                <span>5-1</span>
              </div>
            </div>
          </div>
          <div class="answer-actions"><button>复制</button><button>重新生成</button></div>
          <div class="meta-layer">
            <div>
              <div>
                <div>
                  <span class="floating-answer-fragment">-6</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
      <textarea placeholder="给 DeepSeek 发送消息"></textarea>
    `

    const text = await createDeepSeekAdapter().getLastResponse()

    expect(text).toContain('昨天（2026年6月21日）进行了几场世界杯小组赛第二轮的比赛')
    expect(text).toContain('德国 vs 特拉迪瓦')
    expect(text).toContain('荷兰 vs 瑞典')
    expect(text).not.toBe('-6')
  })

  it('captures only the latest DeepSeek turn when a chat contains multiple answers', async () => {
    document.body.innerHTML = `
      <main>
        <section class="answer-list">
          <article class="ds-turn">
            <div class="bubble">你们好</div>
            <div class="answer-content">
              <p>你好呀！😊 很高兴见到你！</p>
              <p>我是DeepSeek，由深度求索公司创造的AI助手。</p>
            </div>
          </article>
          <article class="ds-turn">
            <div class="bubble">今天世界杯是哪几场比赛?</div>
            <div class="answer-content">
              <p>根据搜索结果，2026年6月22日（今天）的世界杯赛程安排如下：</p>
              <ul>
                <li>00:00：西班牙 vs 沙特阿拉伯</li>
                <li>03:00：比利时 vs 伊朗</li>
                <li>06:00：乌拉圭 vs 佛得角</li>
              </ul>
            </div>
          </article>
        </section>
      </main>
      <textarea placeholder="给 DeepSeek 发送消息"></textarea>
    `

    const text = await createDeepSeekAdapter().getLastResponse()

    expect(text).toContain('根据搜索结果，2026年6月22日')
    expect(text).toContain('西班牙 vs 沙特阿拉伯')
    expect(text).not.toContain('你好呀')
    expect(text).not.toContain('我是DeepSeek，由深度求索公司创造的AI助手')
  })

  it('captures the DeepSeek answer instead of a later search references block', async () => {
    document.body.innerHTML = `
      <main>
        <div class="message user">下一场世界杯比赛是哪一个队?</div>
        <div class="message assistant">
          <p>下一场世界杯比赛是阿根廷 vs 奥地利。</p>
          <p>比赛时间是北京时间 6 月 23 日 01:00。</p>
          <div class="actions"><button>复制</button><button>重新生成</button></div>
        </div>
        <div class="message assistant search-references">
          已阅读 10 个网页
        </div>
      </main>
      <textarea placeholder="给 DeepSeek 发送消息"></textarea>
    `

    const text = await createDeepSeekAdapter().getLastResponse()

    expect(text).toContain('下一场世界杯比赛是阿根廷 vs 奥地利')
    expect(text).toContain('6 月 23 日 01:00')
    expect(text).not.toBe('已阅读 10 个网页')
  })

  it('prefers the latest complete DeepSeek answer over an older markdown paragraph', async () => {
    document.body.innerHTML = `
      <main>
        <div class="_9663006 _2c189bc">你们好</div>
        <div class="_4f9bf79 _43c05b5">
          <p class="ds-markdown-paragraph">你好！很高兴见到你！😊</p>
          <p class="ds-markdown-paragraph">我是DeepSeek，一个由深度求索公司创造的AI助手。</p>
          <p class="ds-markdown-paragraph">有什么我可以帮你的吗？</p>
        </div>
        <div class="_9663006">今天世界杯,进球最多的队是哪一个?</div>
        <div class="_4f9bf79 d7dc56a8 _43c05b5">
          <p class="ds-markdown-paragraph">关于2026年世界杯“进球最多的队”，要分两种情况来看：</p>
          <ul>
            <li>历史总进球数最多的球队：巴西队。</li>
            <li>本届赛事目前进球最多的球队：德国队。</li>
          </ul>
        </div>
      </main>
      <textarea placeholder="给 DeepSeek 发送消息"></textarea>
    `

    const text = await createDeepSeekAdapter().getLastResponse()

    expect(text).toContain('关于2026年世界杯')
    expect(text).toContain('德国队')
    expect(text).not.toContain('我是DeepSeek，一个由深度求索公司创造的AI助手')
  })

  it('does not capture an obfuscated DeepSeek user bubble as the assistant answer', async () => {
    document.body.innerHTML = `
      <main>
        <div class="_9663006 _2c189bc">你们好, 接下来你们用最简短的语言来回答我的问题</div>
        <div class="_4f9bf79 d7dc56a8 _43c05b5">好的，请问。</div>
      </main>
      <textarea placeholder="给 DeepSeek 发送消息"></textarea>
    `

    await expect(createDeepSeekAdapter({ response: ['main div'] }).getLastResponse()).resolves.toBe('好的，请问。')
  })

  it('does not capture a DeepSeek ds-message user bubble as a short assistant answer', async () => {
    document.body.innerHTML = `
      <main>
        <div class="d29f3d7d ds-message _63c77b1">你们好, 接下来你们用最简短的语言来回答我的问题</div>
        <div class="_4f9bf79 d7dc56a8 _43c05b5">好的，请问。</div>
      </main>
      <textarea placeholder="给 DeepSeek 发送消息"></textarea>
    `

    await expect(createDeepSeekAdapter({ response: ['main div'] }).getLastResponse()).resolves.toBe('好的，请问。')
  })

  it('uses the current DeepSeek answer marker instead of ds-message user bubbles', async () => {
    document.body.innerHTML = `
      <main>
        <div class="d29f3d7d ds-message _63c77b1">你们好, 接下来你们用最简短的语言来回答我的问题</div>
        <div class="_4f9bf79 _43c05b5">好的，请问。</div>
        <div class="d29f3d7d ds-message _63c77b1">今天进球最多的人是谁? 给我1个名字就好了</div>
        <div class="_4f9bf79 d7dc56a8 _43c05b5">已阅读 10 个网页 奥亚萨瓦尔-1 10 个网页</div>
      </main>
      <textarea placeholder="给 DeepSeek 发送消息"></textarea>
    `

    await expect(createDeepSeekAdapter({ response: ['main div'] }).getLastResponse()).resolves.toBe('奥亚萨瓦尔')
  })

  it('removes DeepSeek search reference markers without changing answer content', async () => {
    document.body.innerHTML = `
      <main>
        <div class="message user">今天比赛情况?</div>
        <div class="message assistant">
          <p>已阅读 10 个网页</p>
          <p>德国队目前进球最多-1，奥亚萨瓦尔也有进球-2。</p>
          <p>10 个网页</p>
        </div>
      </main>
      <textarea placeholder="给 DeepSeek 发送消息"></textarea>
    `

    await expect(createDeepSeekAdapter().getLastResponse()).resolves.toBe('德国队目前进球最多，奥亚萨瓦尔也有进球。')
  })

  it('expands a searched DeepSeek answer to the toolbar-bounded response block', async () => {
    document.body.innerHTML = `
      <main>
        <div class="ds-message">
          <div class="bubble">世界杯的情况</div>
        </div>
        <div class="ds-message">
          <p>目前的2026年世界杯正处于小组赛阶段。</p>
          <p>以下是今天的相关赛事情况：</p>
          <ul>
            <li>新西兰 vs 埃及：比赛正在进行中。</li>
            <li>西班牙 4-0 沙特阿拉伯。</li>
          </ul>
          <div class="ds-flex actions">
            <button>复制</button>
            <button>重新生成</button>
            <button>点赞</button>
          </div>
        </div>
        <div class="ds-message search-references">已阅读 10 个网页</div>
      </main>
      <textarea placeholder="给 DeepSeek 发送消息"></textarea>
    `

    const text = await createDeepSeekAdapter().getLastResponse()

    expect(text).toContain('目前的2026年世界杯正处于小组赛阶段')
    expect(text).toContain('以下是今天的相关赛事情况')
    expect(text).toContain('西班牙 4-0 沙特阿拉伯')
    expect(text).not.toBe('目前的2026年世界杯正处于小组赛阶段。')
    expect(text).not.toBe('已阅读 10 个网页')
  })

  it('prints DeepSeek capture candidates only when capture debug is enabled', async () => {
    document.body.innerHTML = `
      <main>
        <div class="message user">下一场世界杯比赛是哪一个队?</div>
        <div class="message assistant">
          <p>下一场世界杯比赛是阿根廷 vs 奥地利。</p>
        </div>
        <div class="message assistant search-references">已阅读 10 个网页</div>
      </main>
      <textarea placeholder="给 DeepSeek 发送消息"></textarea>
    `
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await createDeepSeekAdapter().getLastResponse()
    expect(logSpy).not.toHaveBeenCalled()

    localStorage.setItem('CHATDUEL_DEBUG_CAPTURE', '1')
    await createDeepSeekAdapter().getLastResponse()

    await vi.waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith(
        '[ChatDuel capture debug]',
        expect.stringContaining('"platform":"deepseek"'),
      )
      expect(logSpy).toHaveBeenCalledWith(
        '[ChatDuel capture debug]',
        expect.stringContaining('"event":"candidates"'),
      )
      expect(logSpy).toHaveBeenCalledWith(
        '[ChatDuel capture debug]',
        expect.stringContaining('阿根廷 vs 奥地利'),
      )
    })
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
      await vi.advanceTimersByTimeAsync(4100)
      await upload

      expect(input.files?.[0]?.name).toBe('cursor.png')
      expect(changeSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects image sending when DeepSeek is in quick mode', async () => {
    document.body.innerHTML = `
      <header>简短回答准备 快速模式</header>
      <div class="composer">
        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt">
        <textarea placeholder="给 DeepSeek 发送消息"></textarea>
      </div>
    `

    await expect(
      createDeepSeekAdapter().sendMessage('这是什么图?', new File(['image'], 'cursor.png', { type: 'image/png' })),
    ).rejects.toThrow('DeepSeek 仅识图模式支持图片')
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

  it('rejects a DeepSeek pasted image when the preview is marked as abnormal', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div class="composer">
        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt">
        <textarea placeholder="给 DeepSeek 发送消息"></textarea>
      </div>
    `
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.addEventListener('paste', () => {
      const preview = document.createElement('button')
      preview.className = 'upload-file'
      preview.textContent = 'cursor.png 未提取到文字 删除异常文件'
      document.querySelector('.composer')?.appendChild(preview)
    })

    try {
      const upload = createDeepSeekAdapter().attachImage(new File(['image'], 'cursor.png', { type: 'image/png' }))
      const expectedFailure = expect(upload).rejects.toThrow('deepseek image upload rejected as abnormal file')
      await vi.advanceTimersByTimeAsync(2500)
      await expectedFailure
    } finally {
      vi.useRealTimers()
    }
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

  it('does not dispatch drop after paste creates a DeepSeek attachment preview in the wider composer', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = `
      <div class="composer">
        <div class="inner-composer">
          <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt">
          <textarea placeholder="给 DeepSeek 发送消息"></textarea>
        </div>
      </div>
    `
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!
    const pasteSpy = vi.fn(() => {
      const preview = document.createElement('span')
      preview.className = 'upload-file'
      preview.textContent = 'cursor.png'
      document.querySelector('.composer')?.appendChild(preview)
    })
    const dropSpy = vi.fn(() => {
      const preview = document.createElement('span')
      preview.className = 'upload-file'
      preview.textContent = 'cursor.png'
      document.querySelector('.composer')?.appendChild(preview)
    })
    textarea.addEventListener('paste', pasteSpy)
    textarea.addEventListener('drop', dropSpy)

    try {
      const upload = createDeepSeekAdapter().attachImage(new File(['image'], 'cursor.png', { type: 'image/png' }))
      await vi.advanceTimersByTimeAsync(6200)
      await expect(upload).resolves.toBeUndefined()

      expect(pasteSpy).toHaveBeenCalledTimes(1)
      expect(dropSpy).not.toHaveBeenCalled()
      expect(document.querySelectorAll('.upload-file')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('prints DeepSeek upload diagnostics only when capture debug is enabled', async () => {
    document.body.innerHTML = `
      <div class="composer">
        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt">
        <textarea placeholder="给 DeepSeek 发送消息"></textarea>
      </div>
    `
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!
    textarea.addEventListener('paste', () => {
      const preview = document.createElement('span')
      preview.className = 'upload-file'
      preview.textContent = 'cursor.png'
      document.querySelector('.composer')?.appendChild(preview)
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await createDeepSeekAdapter().attachImage(new File(['image'], 'cursor.png', { type: 'image/png' }))
    expect(logSpy).not.toHaveBeenCalled()

    localStorage.setItem('CHATDUEL_DEBUG_CAPTURE', '1')
    await createDeepSeekAdapter().attachImage(new File(['image'], 'cursor.png', { type: 'image/png' }))

    await vi.waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith(
        '[ChatDuel capture debug]',
        expect.stringContaining('"event":"upload-attempt"'),
      )
      expect(logSpy).toHaveBeenCalledWith(
        '[ChatDuel capture debug]',
        expect.stringContaining('"route":"paste-drop"'),
      )
      expect(logSpy).toHaveBeenCalledWith(
        '[ChatDuel capture debug]',
        expect.stringContaining('"ok":true'),
      )
    })
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

describe('ensureDeepSeekVisionMode', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not click when vision mode is explicitly active', async () => {
    document.body.innerHTML = `
      <button aria-selected="true">识图模式</button>
    `
    const btn = document.querySelector('button')!
    const clickSpy = vi.fn()
    btn.addEventListener('click', clickSpy)

    const promise = ensureDeepSeekVisionMode()
    await vi.advanceTimersByTimeAsync(500)
    const result = await promise

    expect(result).toBe(true)
    expect(clickSpy).toHaveBeenCalledTimes(0)
  })

  it('clicks once and waits for explicit vision evidence', async () => {
    document.body.innerHTML = `
      <button>识图模式</button>
    `
    const btn = document.querySelector('button')!
    btn.addEventListener('click', () => {
      btn.setAttribute('aria-selected', 'true')
    })

    const promise = ensureDeepSeekVisionMode()
    await vi.advanceTimersByTimeAsync(500)
    const result = await promise

    expect(result).toBe(true)
  })

  it('waits for a delayed vision mode button', async () => {
    setTimeout(() => {
      const btn = document.createElement('button')
      btn.textContent = '识图模式'
      btn.addEventListener('click', () => {
        btn.setAttribute('aria-selected', 'true')
      })
      document.body.appendChild(btn)
    }, 2000)

    const promise = ensureDeepSeekVisionMode()
    await vi.advanceTimersByTimeAsync(8500)
    const result = await promise

    expect(result).toBe(true)
  })

  it('returns false when the button never appears', async () => {
    document.body.innerHTML = ''

    const promise = ensureDeepSeekVisionMode()
    await vi.advanceTimersByTimeAsync(8500)
    const result = await promise

    expect(result).toBe(false)
  })

  it('does not repeatedly click when verification times out', async () => {
    document.body.innerHTML = `
      <button>识图模式</button>
    `
    const btn = document.querySelector('button')!
    const clickSpy = vi.fn()
    btn.addEventListener('click', clickSpy)

    const promise = ensureDeepSeekVisionMode()
    await vi.advanceTimersByTimeAsync(8500)
    const result = await promise

    expect(result).toBe(false)
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('ignores hidden and disabled matching controls', async () => {
    document.body.innerHTML = `
      <button hidden>识图模式</button>
      <button disabled>识图模式</button>
      <button aria-hidden="true">识图模式</button>
      <button aria-disabled="true">识图模式</button>
      <div role="button" style="display:none">识图模式</div>
    `
    const controls = document.querySelectorAll<HTMLElement>('button, [role="button"]')
    const clickSpies = [...controls].map((el) => {
      const spy = vi.fn()
      el.addEventListener('click', spy)
      return spy
    })

    const promise = ensureDeepSeekVisionMode()
    await vi.advanceTimersByTimeAsync(8500)
    const result = await promise

    expect(result).toBe(false)
    clickSpies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(0))
  })

  it('does not treat an unknown page state as success', async () => {
    document.body.innerHTML = `
      <div>Some unrelated content</div>
    `

    const promise = ensureDeepSeekVisionMode()
    await vi.advanceTimersByTimeAsync(8500)
    const result = await promise

    expect(result).toBe(false)
  })

  it('matches a DeepSeek radio button with doubled vision mode text', async () => {
    // DeepSeek 的 radio 按钮内有一个可见 label 和一个 aria-hidden 副本，
    // 导致 textContent 为 "识图模式识图模式"。
    document.body.innerHTML = `
      <div role="radio">
        <div>识图模式</div>
        <div aria-hidden="true">识图模式</div>
      </div>
    `
    const radio = document.querySelector('[role="radio"]')!
    const clickSpy = vi.fn()
    radio.addEventListener('click', () => {
      radio.setAttribute('aria-selected', 'true')
    })
    radio.addEventListener('click', clickSpy)

    const promise = ensureDeepSeekVisionMode()
    await vi.advanceTimersByTimeAsync(500)
    const result = await promise

    expect(result).toBe(true)
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })
})
