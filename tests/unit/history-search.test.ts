import { describe, expect, it } from 'vitest'
import type { Session } from '../../src/types'
import { filterSessionsByTitle } from '../../src/lib/history-search'

function makeSession(id: string, prompt: string): Session {
  return {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    prompt,
    sentPrompt: prompt,
    targetPlatforms: ['chatgpt'],
    responses: {},
    attachments: [],
    followUps: [],
    summaries: [],
  }
}

describe('history search', () => {
  it('filters sessions by prompt title only', () => {
    const sessions = [
      makeSession('a', 'F1 西班牙站赛况如何'),
      makeSession('b', '豆包图片识别测试'),
      makeSession('c', '你好'),
    ]

    const result = filterSessionsByTitle(sessions, '西班牙')

    expect(result.map((session) => session.id)).toEqual(['a'])
  })

  it('returns all sessions when the query is blank', () => {
    const sessions = [
      makeSession('a', '问题 A'),
      makeSession('b', '问题 B'),
    ]

    expect(filterSessionsByTitle(sessions, '   ')).toEqual(sessions)
  })
})
