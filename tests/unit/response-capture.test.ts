import { describe, expect, it } from 'vitest'
import { evaluateResponseCapture } from '../../src/lib/response-capture'

describe('response-capture', () => {
  it('does not capture while the AI is still streaming even if text is available', () => {
    const result = evaluateResponseCapture(
      { text: '前半段回答', status: 'streaming' },
      '',
      undefined,
      2,
    )

    expect(result.shouldCapture).toBe(false)
    expect(result.progress.lastText).toBe('前半段回答')
    expect(result.progress.stableCount).toBe(0)
  })

  it('captures only after the response text is stable after generation stops', () => {
    const first = evaluateResponseCapture(
      { text: '完整回答', status: 'finished' },
      '',
      undefined,
      2,
    )
    const second = evaluateResponseCapture(
      { text: '完整回答', status: 'finished' },
      '',
      first.progress,
      2,
    )

    expect(first.shouldCapture).toBe(false)
    expect(first.progress.stableCount).toBe(1)
    expect(second.shouldCapture).toBe(true)
    expect(second.progress.stableCount).toBe(2)
  })

  it('resets stability when the text changes', () => {
    const first = evaluateResponseCapture(
      { text: '第一版', status: 'finished' },
      '',
      undefined,
      2,
    )
    const second = evaluateResponseCapture(
      { text: '第二版', status: 'finished' },
      '',
      first.progress,
      2,
    )

    expect(second.shouldCapture).toBe(false)
    expect(second.progress.lastText).toBe('第二版')
    expect(second.progress.stableCount).toBe(1)
  })
})
