import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createClaudeAdapter } from '../../src/adapters/claude/adapter'
import type { AdapterDiagnostics } from '../../src/adapters/base'

function diagnostics() {
  const emit = vi.fn()
  return { emit, value: { reporter: { emit }, selectorConfigVersion: '2026.07' } satisfies AdapterDiagnostics }
}

// 这些测试跑在 jsdom 里，直接构造 Claude 官网 DOM 片段来验证适配器逻辑。
// 选择器沿用 adapters/claude/selectors.json 的默认值。

function setBody(html: string): void {
  document.body.innerHTML = html
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('Claude 适配器：回答抓取与降噪', () => {
  it('removes Claude tool progress and icon-only action text from captured responses', () => {
    const main = document.createElement('main')
    const msg = document.createElement('div')
    msg.setAttribute('data-testid', 'assistant-message')
    msg.textContent = [
      'Here is the answer.',
      'Fetching sports data',
      'Searched the web',
      'Searched the web, used a tool',
      '↻',
      'Final sentence.',
    ].join('\n')
    main.appendChild(msg)
    document.body.appendChild(main)

    const adapter = createClaudeAdapter()
    return adapter.getLastResponse().then((text) => {
      expect(text).toContain('Here is the answer.')
      expect(text).toContain('Final sentence.')
      expect(text).not.toContain('Fetching sports data')
      expect(text).not.toContain('Searched the web')
      expect(text).not.toContain('↻')
    })
  })

  it('reads Claude responses from plain main text when semantic assistant markers are missing', () => {
    const main = document.createElement('main')
    const block = document.createElement('div')
    block.className = 'some-block'
    block.textContent = 'Plain answer without semantic markers.'
    main.appendChild(block)
    document.body.appendChild(main)

    const adapter = createClaudeAdapter()
    return adapter.getLastResponse().then((text) => {
      expect(text).toBe('Plain answer without semantic markers.')
    })
  })

  it('returns empty string when there is no response yet', () => {
    const main = document.createElement('main')
    document.body.appendChild(main)
    const adapter = createClaudeAdapter()
    return adapter.getLastResponse().then((text) => {
      expect(text).toBe('')
    })
  })
})

describe('Claude 适配器：会话状态机（选择器缺失兜底）', () => {
  it('reports finished when a plain response block exists and no stop button is present', () => {
    const main = document.createElement('main')
    const block = document.createElement('div')
    block.className = 'some-block'
    block.textContent = 'Claude finished its answer here.'
    main.appendChild(block)
    document.body.appendChild(main)

    const adapter = createClaudeAdapter()
    return adapter.getConversationState().then((state) => {
      expect(state.status).toBe('finished')
      expect(state.lastResponse).toContain('Claude finished its answer here.')
    })
  })

  it('reports idle (not finished) when there is no response text at all', () => {
    const main = document.createElement('main')
    document.body.appendChild(main)

    const adapter = createClaudeAdapter()
    return adapter.getConversationState().then((state) => {
      expect(state.status).toBe('idle')
    })
  })
})

describe('Claude 适配器：发送兜底', () => {
  it('retries with Enter when clicking Claude send leaves the prompt in the composer', () => {
    const box = document.createElement('div')
    box.setAttribute('contenteditable', 'true')
    box.setAttribute('role', 'textbox')
    box.textContent = 'Hello Claude'
    document.body.appendChild(box)

    const btn = document.createElement('button')
    btn.setAttribute('aria-label', 'Send message')
    // 模拟点击发送无效：composer 里仍残留 prompt
    document.body.appendChild(btn)

    // 真实 Claude 在 iframe 下有时点击不提交，键盘 Enter 才生效
    box.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') box.textContent = ''
    })

    const trace = diagnostics()
    const adapter = createClaudeAdapter()
    return adapter.sendMessage('Hello Claude', undefined, trace.value).then(() => {
      expect(box.textContent).toBe('')
      expect(trace.emit).toHaveBeenLastCalledWith(expect.objectContaining({
        operation: 'send-ack', stage: 'accepted', retryCount: 1,
      }))
      expect(trace.emit.mock.calls.some(([event]) => event.runOutcome !== undefined)).toBe(false)
    })
  })

  it('reports Claude send failure when the prompt stays in the composer after fallback', () => {
    const box = document.createElement('div')
    box.setAttribute('contenteditable', 'true')
    box.setAttribute('role', 'textbox')
    box.textContent = 'Hi Claude'
    document.body.appendChild(box)

    const btn = document.createElement('button')
    btn.setAttribute('aria-label', 'Send message')
    // 点击和 Enter 都不清空(composer 始终残留)→ 应判定发送失败
    document.body.appendChild(btn)

    const trace = diagnostics()
    const adapter = createClaudeAdapter()
    return expect(adapter.sendMessage('Hi Claude', undefined, trace.value)).rejects
      .toThrow('claude message did not submit')
      .then(() => {
        expect(trace.emit).toHaveBeenLastCalledWith(expect.objectContaining({
          operation: 'send-ack', runOutcome: 'failed', errorCode: 'message-not-accepted', retryCount: 3,
        }))
      })
  })
})

describe('Claude 适配器：data-last-message 最新回复定位', () => {
  it('returns the latest AI response via data-last-message when newest message is from Claude', () => {
    setBody(`
      <main>
        <div data-rs-index="0"><article role="article" aria-label="Message 1 of 2">You said: 你好</article></div>
        <div data-rs-index="1" data-last-message="true"><article role="article" aria-label="Message 2 of 2">Claude responded: 这是最新的AI回复。</article></div>
      </main>
    `)
    const adapter = createClaudeAdapter()
    return adapter.getLastResponse().then((text) => {
      expect(text).toBe('这是最新的AI回复。')
    })
  })

  it('falls back to the previous AI response when data-last-message points to a user question', () => {
    // 用户刚提问、AI 还没回答时，data-last-message 标在用户消息上，
    // 应回退取倒数第二条 AI 回复，而不是误抓用户提问。
    setBody(`
      <main>
        <div data-rs-index="0"><article role="article" aria-label="Message 1 of 3">Claude responded: 这是第一轮AI回复。</article></div>
        <div data-rs-index="1"><article role="article" aria-label="Message 2 of 3">You said: 再问一个问题</article></div>
        <div data-rs-index="2" data-last-message="true"><article role="article" aria-label="Message 3 of 3">You said: 这是最新的用户提问，AI还没回答</article></div>
      </main>
    `)
    const adapter = createClaudeAdapter()
    return adapter.getLastResponse().then((text) => {
      expect(text).toBe('这是第一轮AI回复。')
    })
  })

  it('prefers the newest AI response over a longer older one (no longest-text selection)', () => {
    // 回归测试：旧版用「选最长文本」会误把更长的旧回答当当前回答，
    // 导致抓取文本 == 发送前基线而被判定「无新内容」不写记录。
    setBody(`
      <main>
        <div data-rs-index="0"><article role="article" aria-label="Message 1 of 3">Claude responded: 这是一段非常非常长的旧回答内容用来验证我们不再错误地选择最长文本而是选择最新的AI回复。</article></div>
        <div data-rs-index="1"><article role="article" aria-label="Message 2 of 3">You said: 一个问题</article></div>
        <div data-rs-index="2" data-last-message="true"><article role="article" aria-label="Message 3 of 3">Claude responded: 短回复。</article></div>
      </main>
    `)
    const adapter = createClaudeAdapter()
    return adapter.getLastResponse().then((text) => {
      expect(text).toBe('短回复。')
    })
  })
})
