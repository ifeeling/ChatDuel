import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDoubaoAdapter, probeDoubaoAttachmentControls } from '../../src/adapters/doubao/adapter'

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

  it('detects explicit file inputs as probe evidence without enabling auto upload yet', () => {
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
      canAutoUploadImage: false,
      canAutoUploadFile: false,
      reason: '发现上传入口,但豆包自动上传流程尚未验证',
    })
  })
})
