import { describe, expect, it } from 'vitest'
import { buildHistoryBlock, buildSummaryPrompt, hasCapturedResponses } from '../../src/lib/summary-builder'
import type { Session } from '../../src/types'

const session: Session = {
  id: 's1',
  createdAt: 1000,
  updatedAt: 2000,
  prompt: '怎么做历史记录？',
  sentPrompt: '怎么做历史记录？',
  targetPlatforms: ['chatgpt', 'gemini'],
  responses: {
    chatgpt: { text: '先保存用户问题。', status: 'captured', capturedAt: 1500 },
    gemini: { text: '再保存 AI 回答。', status: 'captured', capturedAt: 1600 },
  },
  attachments: [],
  followUps: [],
  summaries: [],
}

describe('summary-builder', () => {
  it('detects captured responses', () => {
    expect(hasCapturedResponses(session)).toBe(true)
    expect(hasCapturedResponses({ ...session, responses: {} })).toBe(false)
  })

  it('builds a history block from one session', () => {
    const block = buildHistoryBlock(session)
    expect(block).toContain('### 第 1 轮')
    expect(block).toContain('【用户问题】')
    expect(block).toContain('怎么做历史记录？')
    expect(block).toContain('【ChatGPT 回答】')
    expect(block).toContain('先保存用户问题。')
    expect(block).toContain('【Gemini 回答】')
    expect(block).toContain('再保存 AI 回答。')
  })

  it('renders a summary prompt with historyBlock', () => {
    const prompt = buildSummaryPrompt('请总结：\n{{historyBlock}}', session)
    expect(prompt).toContain('请总结：')
    expect(prompt).toContain('### 第 1 轮')
    expect(prompt).toContain('先保存用户问题。')
  })

  it('can build a summary prompt from only selected AI responses', () => {
    const threeAiSession: Session = {
      ...session,
      targetPlatforms: ['chatgpt', 'gemini', 'doubao'],
      responses: {
        chatgpt: { text: 'ChatGPT 内容。', status: 'captured' },
        gemini: { text: 'Gemini 内容。', status: 'captured' },
        doubao: { text: '豆包内容。', status: 'captured' },
      },
    }

    const prompt = buildSummaryPrompt('请总结：\n{{historyBlock}}', threeAiSession, {
      includedPlatforms: ['chatgpt', 'gemini'],
    })

    expect(prompt).toContain('ChatGPT 内容。')
    expect(prompt).toContain('Gemini 内容。')
    expect(prompt).not.toContain('豆包内容。')
  })

  it('adds an opinion digest instruction for suggestion aggregation mode', () => {
    const prompt = buildSummaryPrompt('请总结：\n{{modeInstruction}}\n{{historyBlock}}', session, {
      mode: 'opinion-digest',
      modeLabel: '汇总意见',
    })

    expect(prompt).toContain('只提取各 AI 提出的意见、建议、风险提醒和待确认点')
    expect(prompt).toContain('不要保留寒暄、客套话')
    expect(prompt).toContain('Gemini')
    expect(prompt).toContain('ChatGPT')
  })

  it('adds mode-specific instructions for differences and short summaries', () => {
    const differences = buildSummaryPrompt('请总结：\n{{modeInstruction}}\n{{historyBlock}}', session, {
      mode: 'differences',
      modeLabel: '只看分歧',
    })
    const shortSummary = buildSummaryPrompt('请总结：\n{{modeInstruction}}\n{{historyBlock}}', session, {
      mode: 'short-summary',
      modeLabel: '简短摘要',
    })

    expect(differences).toContain('只输出各 AI 之间不一致、互相补充或重点不同的地方')
    expect(shortSummary).toContain('用尽量短的篇幅给出结论')
  })

  it('builds a history block from selected sessions', () => {
    const second: Session = {
      ...session,
      id: 's2',
      createdAt: 3000,
      prompt: '怎么做总结？',
      sentPrompt: '怎么做总结？',
      responses: {
        chatgpt: { text: '先选择历史。', status: 'captured', capturedAt: 3500 },
        gemini: { text: '再合并回答。', status: 'captured', capturedAt: 3600 },
      },
    }

    const block = buildHistoryBlock([session, second])

    expect(block).toContain('### 第 1 轮')
    expect(block).toContain('怎么做历史记录？')
    expect(block).toContain('### 第 2 轮')
    expect(block).toContain('怎么做总结？')
  })
})
