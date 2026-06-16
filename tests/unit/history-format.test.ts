import { describe, expect, it } from 'vitest'
import { buildSessionMarkdownExport, formatSessionMarkdown, summarizeSessionTargets } from '../../src/lib/history-format'
import type { Session } from '../../src/types'

const makeSession = (): Session => ({
  id: 's1',
  createdAt: 1000,
  updatedAt: 2000,
  prompt: '你好',
  sentPrompt: '你好',
  targetPlatforms: ['chatgpt', 'gemini'],
  responses: {
    chatgpt: { text: '你好！', status: 'captured', capturedAt: 1500 },
    gemini: { text: '', status: 'pending' },
  },
  attachments: [{
    id: 'a1',
    name: 'image.png',
    mime: 'image/png',
    size: 2048,
    kind: 'image',
    handling: 'file-upload',
    uploadStatus: 'pending',
  }],
  followUps: [],
  summaries: [],
})

describe('history-format', () => {
  it('summarizes target response statuses', () => {
    expect(summarizeSessionTargets(makeSession())).toBe('ChatGPT 已记录 / Gemini 待回填')
  })

  it('formats a session as readable markdown', () => {
    const markdown = formatSessionMarkdown(makeSession())

    expect(markdown).toContain('# 你好')
    expect(markdown).toContain('## 用户问题')
    expect(markdown).toContain('## 附件')
    expect(markdown).toContain('- image.png · image/png · 2 KB')
    expect(markdown).toContain('## ChatGPT 回答')
    expect(markdown).toContain('你好！')
    expect(markdown).toContain('## Gemini 回答')
    expect(markdown).toContain('待回填')
  })

  it('builds a downloadable markdown report payload', () => {
    const report = buildSessionMarkdownExport({
      ...makeSession(),
      prompt: '你好 / Gemini?',
    })

    expect(report.filename).toBe('AIChatRoom-你好-Gemini.md')
    expect(report.mime).toBe('text/markdown;charset=utf-8')
    expect(report.content).toContain('# 你好 / Gemini?')
  })

  it('restores simple headings and paragraph breaks in captured markdown-like text', () => {
    const markdown = formatSessionMarkdown({
      ...makeSession(),
      responses: {
        chatgpt: {
          status: 'captured',
          text: '第一段内容。 ## 重点结论 这里是结论。 ### 风险提醒 这里是风险。',
        },
        gemini: { text: '', status: 'pending' },
      },
    })

    expect(markdown).toContain('第一段内容。\n\n## 重点结论\n\n这里是结论。')
    expect(markdown).toContain('\n\n### 风险提醒\n\n这里是风险。')
  })
})
