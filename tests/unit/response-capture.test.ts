import { describe, expect, it } from 'vitest'
import {
  RESPONSE_ABSOLUTE_TIMEOUT_MS,
  RESPONSE_NO_PROGRESS_TIMEOUT_MS,
  evaluateResponseCapture,
  isResponseCompleteForUnlock,
  partitionResponseCapturePlatforms,
  shouldResponseCaptureTimeout,
} from '../../src/lib/response-capture'

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

  it('allows unlock as soon as a non-active new response is visible', () => {
    expect(isResponseCompleteForUnlock({ text: '新回答', status: 'finished' }, '旧回答')).toBe(true)
    expect(isResponseCompleteForUnlock({ text: '新回答', status: 'streaming' }, '旧回答')).toBe(false)
    expect(isResponseCompleteForUnlock({ text: '旧回答', status: 'finished' }, '旧回答')).toBe(false)
  })

  it('keeps waiting after 60 seconds when streaming content still grows', () => {
    const first = evaluateResponseCapture(
      { text: '第一段', status: 'streaming' }, '', undefined, 2, 0,
    )
    const growing = evaluateResponseCapture(
      { text: '第一段\n第二段', status: 'streaming' }, '', first.progress, 2,
      RESPONSE_NO_PROGRESS_TIMEOUT_MS + 1,
    )

    expect(growing.progress.lastActivityAt).toBe(RESPONSE_NO_PROGRESS_TIMEOUT_MS + 1)
    expect(shouldResponseCaptureTimeout(growing.progress, RESPONSE_NO_PROGRESS_TIMEOUT_MS + 1)).toBe(false)
  })

  it('times out after 60 seconds without any new response content', () => {
    const waiting = evaluateResponseCapture(
      { text: '', status: 'sending' }, '', undefined, 2, 0,
    )

    expect(shouldResponseCaptureTimeout(waiting.progress, RESPONSE_NO_PROGRESS_TIMEOUT_MS - 1)).toBe(false)
    expect(shouldResponseCaptureTimeout(waiting.progress, RESPONSE_NO_PROGRESS_TIMEOUT_MS)).toBe(true)
  })

  it('times out when streaming content stops growing for 60 seconds', () => {
    const started = evaluateResponseCapture(
      { text: '已有回答', status: 'streaming' }, '', undefined, 2, 0,
    )
    const unchanged = evaluateResponseCapture(
      { text: '已有回答', status: 'streaming' }, '', started.progress, 2,
      RESPONSE_NO_PROGRESS_TIMEOUT_MS,
    )

    expect(unchanged.progress.lastActivityAt).toBe(0)
    expect(shouldResponseCaptureTimeout(unchanged.progress, RESPONSE_NO_PROGRESS_TIMEOUT_MS)).toBe(true)
  })

  it('resets inactivity timing when response content changes', () => {
    const started = evaluateResponseCapture(
      { text: '第一段', status: 'streaming' }, '', undefined, 2, 0,
    )
    const changedAt = 50_000
    const changed = evaluateResponseCapture(
      { text: '第一段\n第二段', status: 'streaming' }, '', started.progress, 2, changedAt,
    )

    expect(shouldResponseCaptureTimeout(
      changed.progress,
      changedAt + RESPONSE_NO_PROGRESS_TIMEOUT_MS - 1,
    )).toBe(false)
    expect(shouldResponseCaptureTimeout(
      changed.progress,
      changedAt + RESPONSE_NO_PROGRESS_TIMEOUT_MS,
    )).toBe(true)
  })

  it('does not treat recovery from an empty read as new content activity', () => {
    const started = evaluateResponseCapture(
      { text: '已有回答', status: 'streaming' }, '', undefined, 2, 0,
    )
    const emptyRead = evaluateResponseCapture(
      { text: '', status: 'streaming' }, '', started.progress, 2, 30_000,
    )
    const sameTextAgain = evaluateResponseCapture(
      { text: '已有回答', status: 'streaming' }, '', emptyRead.progress, 2, 59_999,
    )

    expect(sameTextAgain.progress.lastActivityAt).toBe(0)
    expect(shouldResponseCaptureTimeout(sameTextAgain.progress, RESPONSE_NO_PROGRESS_TIMEOUT_MS)).toBe(true)
  })

  it('enforces the ten minute absolute limit even when content just changed', () => {
    const started = evaluateResponseCapture(
      { text: '第一段', status: 'streaming' }, '', undefined, 2, 0,
    )
    const changed = evaluateResponseCapture(
      { text: '第一段\n最后一段', status: 'streaming' }, '', started.progress, 2,
      RESPONSE_ABSOLUTE_TIMEOUT_MS - 1,
    )

    expect(shouldResponseCaptureTimeout(changed.progress, RESPONSE_ABSOLUTE_TIMEOUT_MS)).toBe(true)
  })

  it('partitions each platform independently by its own progress', () => {
    const chatgpt = evaluateResponseCapture(
      { text: '仍在增长', status: 'streaming' }, '', undefined, 2, 59_000,
    ).progress
    const gemini = evaluateResponseCapture(
      { text: '', status: 'sending' }, '', undefined, 2, 0,
    ).progress

    expect(partitionResponseCapturePlatforms(
      ['chatgpt', 'gemini'],
      { chatgpt, gemini },
      RESPONSE_NO_PROGRESS_TIMEOUT_MS,
    )).toEqual({ waiting: ['chatgpt'], timedOut: ['gemini'] })
  })
})
