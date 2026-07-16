import { describe, it, expect, beforeEach } from 'vitest'
import { createClaudeAdapter } from '../../src/adapters/claude/adapter'

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

    const adapter = createClaudeAdapter()
    return adapter.sendMessage('Hello Claude').then(() => {
      expect(box.textContent).toBe('')
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

    const adapter = createClaudeAdapter()
    return expect(adapter.sendMessage('Hi Claude')).rejects.toThrow('claude message did not submit')
  })
})
