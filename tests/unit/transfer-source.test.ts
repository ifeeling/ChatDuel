import { describe, expect, it } from 'vitest'
import type { Session } from '../../src/types'
import { buildTransferSourceOptions, buildTransferContent } from '../../src/lib/transfer-source'

function session(partial: Partial<Session>): Session {
  return {
    id: partial.id ?? 's1',
    createdAt: partial.createdAt ?? 1000,
    updatedAt: partial.updatedAt ?? partial.createdAt ?? 1000,
    prompt: partial.prompt ?? '默认问题',
    sentPrompt: partial.sentPrompt ?? partial.prompt ?? '默认问题',
    targetPlatforms: partial.targetPlatforms ?? ['gemini'],
    responses: partial.responses ?? {},
    attachments: [],
    followUps: [],
    summaries: [],
  }
}

describe('transfer-source', () => {
  it('lists recent captured responses for one source platform with the newest selected by default', () => {
    const options = buildTransferSourceOptions('gemini', [
      session({
        id: 'old',
        createdAt: 1000,
        prompt: '旧问题',
        targetPlatforms: ['gemini'],
        responses: { gemini: { status: 'captured', text: '旧回答' } },
      }),
      session({
        id: 'new',
        createdAt: 2000,
        prompt: '新问题',
        targetPlatforms: ['gemini', 'doubao'],
        responses: {
          gemini: { status: 'captured', text: '新回答' },
          doubao: { status: 'captured', text: '豆包回答' },
        },
      }),
    ])

    expect(options.map((option) => option.id)).toEqual(['new:gemini', 'old:gemini'])
    expect(options[0]).toMatchObject({
      source: 'history',
      platform: 'gemini',
      prompt: '新问题',
      text: '新回答',
      selected: true,
    })
    expect(options[1].selected).toBe(false)
  })

  it('ignores pending, failed, empty, and other-platform responses', () => {
    const options = buildTransferSourceOptions('gemini', [
      session({
        id: 'pending',
        createdAt: 4000,
        targetPlatforms: ['gemini'],
        responses: { gemini: { status: 'pending', text: '' } },
      }),
      session({
        id: 'failed',
        createdAt: 3000,
        targetPlatforms: ['gemini'],
        responses: { gemini: { status: 'failed', text: '', error: 'send failed' } },
      }),
      session({
        id: 'empty',
        createdAt: 2000,
        targetPlatforms: ['gemini'],
        responses: { gemini: { status: 'captured', text: '   ' } },
      }),
      session({
        id: 'chatgpt-only',
        createdAt: 1000,
        targetPlatforms: ['chatgpt'],
        responses: { chatgpt: { status: 'captured', text: 'ChatGPT 回答' } },
      }),
    ])

    expect(options).toEqual([])
  })

  it('deduplicates the current page response when it matches the latest history response', () => {
    const options = buildTransferSourceOptions('gemini', [
      session({
        id: 's1',
        createdAt: 1000,
        prompt: '问题',
        targetPlatforms: ['gemini'],
        responses: { gemini: { status: 'captured', text: '同一条回答' } },
      }),
    ], { currentResponse: '同一条回答' })

    expect(options).toHaveLength(1)
    expect(options[0].source).toBe('history')
  })

  it('adds the current page response as the default option when it differs from history', () => {
    const options = buildTransferSourceOptions('gemini', [
      session({
        id: 's1',
        createdAt: 1000,
        prompt: '原始问题',
        targetPlatforms: ['gemini'],
        responses: { gemini: { status: 'captured', text: '原始回答' } },
      }),
    ], { currentResponse: '最新解读' })

    expect(options.map((option) => option.id)).toEqual(['current:gemini', 's1:gemini'])
    expect(options[0]).toMatchObject({
      source: 'current',
      text: '最新解读',
      selected: true,
    })
    expect(options[1]).toMatchObject({
      source: 'history',
      text: '原始回答',
      selected: false,
    })
  })

  it('formats multiple selected responses with clear boundaries', () => {
    const content = buildTransferContent([
      {
        id: 'a',
        source: 'history',
        platform: 'gemini',
        sessionId: 's1',
        createdAt: 1000,
        prompt: '问题 A',
        text: '回答 A',
        selected: true,
      },
      {
        id: 'b',
        source: 'history',
        platform: 'gemini',
        sessionId: 's2',
        createdAt: 2000,
        prompt: '问题 B',
        text: '回答 B',
        selected: true,
      },
    ], 'Gemini')

    expect(content).toContain('以下是 Gemini 的 2 条回答')
    expect(content).toContain('【回答 1｜Gemini｜')
    expect(content).toContain('问题：问题 A')
    expect(content).toContain('回答 A')
    expect(content).toContain('【回答 2｜Gemini｜')
    expect(content).toContain('问题：问题 B')
    expect(content).toContain('回答 B')
  })
})
