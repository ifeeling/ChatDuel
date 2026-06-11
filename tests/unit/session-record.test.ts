import { describe, it, expect } from 'vitest'
import { applyCapturedResponses, applySendResults, createSessionRecord } from '../../src/lib/session-record'

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
})
