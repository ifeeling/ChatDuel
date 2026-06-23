import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDoubaoAdapter, probeDoubaoAttachmentControls } from '../../src/adapters/doubao/adapter'

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

describe('doubao adapter', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
    vi.restoreAllMocks()
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

  it('reads the latest assistant response from the chat area', async () => {
    document.body.innerHTML = `
      <aside>
        <a>历史对话里的旧标题</a>
      </aside>
      <main>
        <div class="message user">你好</div>
        <div class="message assistant">
          <div class="markdown">你好！我是豆包，可以帮你整理资料。</div>
        </div>
      </main>
      <textarea placeholder="发消息或按住空格说话...">下一条输入</textarea>
    `

    await expect(createDoubaoAdapter().getLastResponse()).resolves.toBe('你好！我是豆包，可以帮你整理资料。')
  })

  it('reports a finished state with the latest assistant response when one is visible', async () => {
    document.body.innerHTML = `
      <main>
        <div class="message assistant">
          <p>第一条回答</p>
        </div>
        <div class="message assistant">
          <p>第二条回答</p>
        </div>
      </main>
      <textarea placeholder="发消息..."></textarea>
    `

    await expect(createDoubaoAdapter().getConversationState()).resolves.toMatchObject({
      status: 'finished',
      lastResponse: '第二条回答',
    })
  })

  it('reports streaming while Doubao shows a stop generating button', async () => {
    document.body.innerHTML = `
      <main>
        <div class="message user">世界杯的情况</div>
        <div class="message assistant">
          <p>目前世界杯正在进行中。</p>
        </div>
      </main>
      <textarea placeholder="发消息或按住空格说话..."></textarea>
      <button aria-label="停止生成"><svg></svg></button>
    `

    await expect(createDoubaoAdapter().getConversationState()).resolves.toMatchObject({
      status: 'streaming',
      lastResponse: '目前世界杯正在进行中。',
    })
  })

  it('ignores guide questions shown after the assistant response', async () => {
    document.body.innerHTML = `
      <main>
        <div class="message user">你好</div>
        <div class="message assistant">
          <p>你好呀～有什么我能帮你的吗？</p>
        </div>
        <div class="message recommend-item">你能介绍一下自己吗？ →</div>
        <div class="message recommend-item">你都有哪些功能？ →</div>
        <div class="message recommend-item">你是如何学习的？ →</div>
      </main>
      <textarea placeholder="发消息或按住空格说话..."></textarea>
    `

    await expect(createDoubaoAdapter().getLastResponse()).resolves.toBe('你好呀～有什么我能帮你的吗？')
  })

  it('removes Doubao follow-up suggestion chips from a captured response block', async () => {
    document.body.innerHTML = `
      <main>
        <div class="message user">你们好</div>
        <div class="message assistant">
          <p>你好呀～有什么我能帮你的吗？</p>
          <div>你们是做什么的？ →</div>
          <div>你们有哪些产品或服务？ →</div>
          <div>你们的优势是什么？ →</div>
        </div>
      </main>
      <textarea placeholder="发消息或按住空格说话..."></textarea>
    `

    await expect(createDoubaoAdapter().getLastResponse()).resolves.toBe('你好呀～有什么我能帮你的吗？')
  })

  it('captures the Doubao answer instead of the later search references block', async () => {
    document.body.innerHTML = `
      <main>
        <div class="message user">下一场世界杯比赛是哪一个队?</div>
        <div class="message assistant">
          <p>当前北京时间 2026 年 06 月 22 日，今日所有比赛已全部打完，下一场世界杯比赛是阿根廷 vs 奥地利。</p>
          <ul>
            <li>赛事：J 组小组赛第二轮</li>
            <li>时间：6 月 23 日 01:00（北京时间）</li>
          </ul>
          <div class="answer-actions"><button>复制</button><button>点赞</button><button>更多</button></div>
        </div>
        <div class="message assistant search-references">
          参考 10 篇资料
        </div>
      </main>
      <textarea placeholder="发消息或按住空格说话..."></textarea>
    `

    const text = await createDoubaoAdapter().getLastResponse()

    expect(text).toContain('下一场世界杯比赛是阿根廷 vs 奥地利')
    expect(text).toContain('6 月 23 日 01:00')
    expect(text).not.toBe('参考 10 篇资料')
  })

  it('does not select the user question when Doubao search answer has toolbar actions', async () => {
    document.body.innerHTML = `
      <main>
        <div class="message">世界杯的情况?</div>
        <article>
          <p>当前北京时间 2026 年 06 月 22 日，今日世界杯主要是小组赛第二轮。</p>
          <p>下一场比赛是阿根廷 vs 奥地利，时间是 6 月 23 日 01:00。</p>
          <div class="answer-actions">
            <button>复制</button>
            <button>点赞</button>
            <button>更多</button>
          </div>
        </article>
        <div class="message search-references">参考 10 篇资料</div>
      </main>
      <textarea placeholder="发消息或按住空格说话..."></textarea>
    `

    const text = await createDoubaoAdapter().getLastResponse()

    expect(text).toContain('当前北京时间 2026 年 06 月 22 日')
    expect(text).toContain('阿根廷 vs 奥地利')
    expect(text).not.toBe('世界杯的情况?')
    expect(text).not.toBe('参考 10 篇资料')
  })

  it('captures only the latest Doubao answer when search mode shows multiple turns', async () => {
    document.body.innerHTML = `
      <main>
        <section class="turn-list">
          <article class="message assistant">
            <p>你好呀～有什么我能帮你的吗？</p>
            <div class="answer-actions"><button>复制</button><button>更多</button></div>
          </article>
          <article class="message assistant">
            <p>下一场世界杯比赛是阿根廷 vs 奥地利。</p>
            <p>比赛时间是北京时间 6 月 23 日 01:00。</p>
            <div class="answer-actions"><button>复制</button><button>更多</button></div>
          </article>
        </section>
      </main>
      <textarea placeholder="发消息或按住空格说话..."></textarea>
    `

    const text = await createDoubaoAdapter().getLastResponse()

    expect(text).toContain('下一场世界杯比赛是阿根廷 vs 奥地利')
    expect(text).not.toContain('你好呀')
  })

  it('does not capture the whole Doubao message list when search mode has older turns', async () => {
    document.body.innerHTML = `
      <main>
        <div class="message-list-zLoNs1 opacity-0 opacity-100">
          <div class="my-0 w-full mx-auto max-w-(--content-max-width)">你们好</div>
          <div class="my-0 w-full mx-auto max-w-(--content-max-width)">你好呀～有什么我能帮你的吗？</div>
          <div class="my-0 w-full mx-auto max-w-(--content-max-width)">今天世界杯,进球最多的队是哪一个?</div>
          <div class="my-0 w-full mx-auto max-w-(--content-max-width)">
            <p># 2026 美加墨世界杯最新进球数据</p>
            <p>本届赛事目前进球最多的球队是德国队，已经打进 9 球。</p>
            <p>如果按世界杯历史总进球数统计，巴西队仍然排在前列。</p>
          </div>
        </div>
      </main>
      <textarea placeholder="发消息或按住空格说话..."></textarea>
    `

    const text = await createDoubaoAdapter().getLastResponse()

    expect(text).toContain('德国队')
    expect(text).toContain('9 球')
    expect(text).not.toContain('你们好')
    expect(text).not.toContain('你好呀～有什么我能帮你的吗？')
    expect(text).not.toContain('今天世界杯,进球最多的队是哪一个?')
  })

  it('does not capture the whole Doubao virtual list or user prompt as the answer', async () => {
    document.body.innerHTML = `
      <main>
        <div class="v_list-D34x3M">
          <div class="my-0 w-full mx-auto max-w-(--content-max-width)">你们好, 接下来你们用最简短的语言来回答我的问题</div>
          <div class="my-0 w-full mx-auto max-w-(--content-max-width)">好，你问。</div>
        </div>
      </main>
      <textarea placeholder="发消息或按住空格说话..."></textarea>
    `

    await expect(createDoubaoAdapter({ response: ['main div'] }).getLastResponse()).resolves.toBe('好，你问。')
  })

  it('captures a Doubao search result instead of the user prompt when the result is short', async () => {
    document.body.innerHTML = `
      <main>
        <div class="v_list-D34x3M">
          <div class="my-0 w-full mx-auto max-w-(--content-max-width)">你们好, 接下来你们用最简短的语言来回答我的问题</div>
          <div class="my-0 w-full mx-auto max-w-(--content-max-width)">好，提问吧。</div>
          <div class="my-0 w-full mx-auto max-w-(--content-max-width)">今天进球最多的人是谁? 给我1个名字就好了</div>
          <div class="my-0 w-full mx-auto max-w-(--content-max-width)">搜索 2 个关键词，参考 11 篇资料 奥亚萨瓦尔 参考 11 篇资料</div>
        </div>
      </main>
      <textarea placeholder="发消息或按住空格说话..."></textarea>
    `

    await expect(createDoubaoAdapter({ response: ['main div'] }).getLastResponse()).resolves.toBe('搜索 2 个关键词，参考 11 篇资料 奥亚萨瓦尔 参考 11 篇资料')
  })

  it('prints Doubao capture candidates only when capture debug is enabled', async () => {
    document.body.innerHTML = `
      <main>
        <div class="message user">下一场世界杯比赛是哪一个队?</div>
        <div class="message assistant">
          <p>下一场世界杯比赛是阿根廷 vs 奥地利。</p>
        </div>
        <div class="message assistant search-references">参考 10 篇资料</div>
      </main>
      <textarea placeholder="发消息或按住空格说话..."></textarea>
    `
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await createDoubaoAdapter().getLastResponse()
    expect(logSpy).not.toHaveBeenCalled()

    localStorage.setItem('CHATDUEL_DEBUG_CAPTURE', '1')
    await createDoubaoAdapter().getLastResponse()

    await vi.waitFor(() => {
      expect(logSpy).toHaveBeenCalledWith(
        '[ChatDuel capture debug]',
        expect.stringContaining('"platform":"doubao"'),
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

  it('does not treat Doubao creation shortcuts as attachment upload support', () => {
    document.body.innerHTML = `
      <main>
        <button>图像生成</button>
        <button>帮我写作</button>
        <button>更多</button>
        <textarea placeholder="发消息或按住空格说话..."></textarea>
      </main>
    `

    expect(probeDoubaoAttachmentControls()).toEqual({
      inputFound: true,
      explicitFileInputFound: false,
      imageFileInputFound: false,
      documentFileInputFound: false,
      misleadingCreationShortcutFound: true,
      canAutoUploadImage: false,
      canAutoUploadFile: false,
      reason: '未发现豆包可自动使用的上传入口',
    })
  })

  it('detects explicit image file inputs as auto-upload evidence', () => {
    document.body.innerHTML = `
      <main>
        <input type="file" accept="image/*,.pdf,.xlsx">
        <textarea placeholder="发消息或按住空格说话..."></textarea>
      </main>
    `

    expect(probeDoubaoAttachmentControls()).toMatchObject({
      inputFound: true,
      explicitFileInputFound: true,
      imageFileInputFound: true,
      documentFileInputFound: true,
      canAutoUploadImage: true,
      canAutoUploadFile: false,
      reason: '发现图片上传入口',
    })
  })

  it('attaches an image through an explicit file input when Doubao exposes one', async () => {
    document.body.innerHTML = '<input type="file" accept="image/*">'
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const changeSpy = vi.fn()
    input.addEventListener('change', changeSpy)

    const file = new File(['image'], 'kitty.png', { type: 'image/png' })
    await createDoubaoAdapter().attachImage(file)

    expect(input.files?.[0]?.name).toBe('kitty.png')
    expect(changeSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back to pasting an image into the composer when a preview appears', async () => {
    document.body.innerHTML = `
      <div class="composer">
        <textarea placeholder="发消息或按住空格说话..."></textarea>
      </div>
    `
    const composer = document.querySelector('.composer')!
    const textarea = document.querySelector('textarea')!
    textarea.addEventListener('paste', () => {
      composer.append(document.createElement('img'))
    })

    const file = new File(['image'], 'kitty.png', { type: 'image/png' })
    await createDoubaoAdapter().attachImage(file)

    expect(composer.querySelector('img')).toBeTruthy()
  })

  it('attaches an image before sending a message when image is provided', async () => {
    document.body.innerHTML = `
      <div class="composer">
        <input type="file" accept="image/*">
        <textarea placeholder="发消息或按住空格说话..."></textarea>
        <button aria-label="发送">发送</button>
      </div>
    `
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const sendSpy = vi.fn()
    document.querySelector('button')!.addEventListener('click', sendSpy)

    const file = new File(['image'], 'kitty.png', { type: 'image/png' })
    await createDoubaoAdapter().sendMessage('这是什么?', file)

    expect(document.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('这是什么?')
    expect(input.files?.[0]?.name).toBe('kitty.png')
    expect(sendSpy).toHaveBeenCalledTimes(1)
  })
})
