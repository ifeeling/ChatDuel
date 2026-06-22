import { describe, it, expect } from 'vitest'
import {
  applyCapturedResponses,
  applySendResults,
  createSessionRecord,
  createSummarySessionRecord,
  isMoreCompleteCapturedResponse,
  isNewCapturedResponse,
  normalizeCapturedResponse,
} from '../../src/lib/session-record'

describe('session-record', () => {
  it('creates a session with target platforms and pending responses', () => {
    const session = createSessionRecord({
      prompt: 'hello',
      sentPrompt: 'hello',
      targetPlatforms: ['chatgpt', 'gemini'],
      now: 1000,
      id: 's1',
    })

    expect(session.id).toBe('s1')
    expect(session.createdAt).toBe(1000)
    expect(session.updatedAt).toBe(1000)
    expect(session.prompt).toBe('hello')
    expect(session.sentPrompt).toBe('hello')
    expect(session.targetPlatforms).toEqual(['chatgpt', 'gemini'])
    expect(session.responses.chatgpt?.status).toBe('pending')
    expect(session.responses.gemini?.status).toBe('pending')
  })

  it('marks failed send targets and leaves successful targets pending', () => {
    const session = createSessionRecord({
      prompt: 'hello',
      sentPrompt: 'hello',
      targetPlatforms: ['chatgpt', 'gemini'],
      now: 1000,
      id: 's1',
    })

    const updated = applySendResults(session, [
      { p: 'chatgpt', ok: true },
      { p: 'gemini', ok: false },
    ], 2000)

    expect(updated.updatedAt).toBe(2000)
    expect(updated.responses.chatgpt?.status).toBe('pending')
    expect(updated.responses.gemini?.status).toBe('failed')
    expect(updated.responses.gemini?.error).toBe('send failed')
  })

  it('captures non-empty latest responses for matching targets', () => {
    const session = createSessionRecord({
      prompt: 'hello',
      sentPrompt: 'hello',
      targetPlatforms: ['chatgpt', 'gemini'],
      now: 1000,
      id: 's1',
    })

    const updated = applyCapturedResponses(session, {
      chatgpt: '你好！',
      gemini: '您好！',
    }, 3000)

    expect(updated.updatedAt).toBe(3000)
    expect(updated.responses.chatgpt).toEqual({
      text: '你好！',
      status: 'captured',
      capturedAt: 3000,
    })
    expect(updated.responses.gemini).toEqual({
      text: '您好！',
      status: 'captured',
      capturedAt: 3000,
    })
  })

  it('trims captured response text before saving', () => {
    expect(normalizeCapturedResponse('deepseek', ' \n你好，cong。\n ')).toBe('你好，cong。')
  })

  it('allows a later fuller response to replace an early partial capture', () => {
    expect(isMoreCompleteCapturedResponse(
      '第一段。\n\n第二段。\n\n第三段。',
      '第二段。',
    )).toBe(true)
    expect(isMoreCompleteCapturedResponse('第二段。', '第一段。\n\n第二段。\n\n第三段。')).toBe(false)
  })

  it('detects whether a captured response is newer than the baseline', () => {
    expect(isNewCapturedResponse('新的回答', '旧的回答')).toBe(true)
    expect(isNewCapturedResponse('旧的回答', '旧的回答')).toBe(false)
    expect(isNewCapturedResponse('   ', '旧的回答')).toBe(false)
  })

  it('creates a visible summary session with pending response', () => {
    const summary = {
      id: 'sum1',
      target: 'chatgpt' as const,
      range: 'manual' as const,
      mode: 'final-answer' as const,
      prompt: '总结提示词',
      status: 'sent' as const,
      sourceSessionIds: ['s1', 's2'],
      timestamp: 1000,
      sentAt: 1000,
    }

    const session = createSummarySessionRecord({
      title: '【总结】两个问题',
      prompt: '总结提示词',
      target: 'chatgpt',
      summary,
      now: 2000,
      id: 'summary-session',
    })

    expect(session.id).toBe('summary-session')
    expect(session.prompt).toBe('【总结】两个问题')
    expect(session.sentPrompt).toBe('总结提示词')
    expect(session.targetPlatforms).toEqual(['chatgpt'])
    expect(session.responses.chatgpt?.status).toBe('pending')
    expect(session.summaries).toEqual([summary])
  })
})
