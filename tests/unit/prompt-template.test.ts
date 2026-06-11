import { describe, it, expect } from 'vitest'
import { renderTemplate, getDefaultTemplates } from '../../src/lib/prompt-template'

describe('renderTemplate', () => {
  it('substitutes {{var}} placeholders', () => {
    const tpl = 'Hello {{name}}, you are {{role}}'
    expect(renderTemplate(tpl, { name: 'Gemini', role: 'reviewer' }))
      .toBe('Hello Gemini, you are reviewer')
  })
  it('leaves unknown placeholders intact', () => {
    expect(renderTemplate('hi {{name}}', {})).toBe('hi {{name}}')
  })
  it('handles missing variables gracefully', () => {
    expect(renderTemplate('{{a}} {{b}}', { a: 'x' })).toBe('x {{b}}')
  })
  it('handles multiple occurrences of the same var', () => {
    expect(renderTemplate('{{x}} and {{x}}', { x: 'A' })).toBe('A and A')
  })
})

describe('getDefaultTemplates', () => {
  it('returns at least review and summary templates', () => {
    const t = getDefaultTemplates()
    expect(t.review).toBeTruthy()
    expect(t.summary).toBeTruthy()
  })
  it('review template contains a {{response}} placeholder', () => {
    const t = getDefaultTemplates()
    expect(t.review).toContain('{{response}}')
  })
  it('summary template contains a {{historyBlock}} placeholder', () => {
    const t = getDefaultTemplates()
    expect(t.summary).toContain('{{historyBlock}}')
  })
})

describe('transfer template', () => {
  it('default templates include transfer', () => {
    const t = getDefaultTemplates()
    expect(t.transfer).toBeTruthy()
  })
  it('transfer template contains {{fromLabel}} and {{content}} placeholders', () => {
    const t = getDefaultTemplates()
    expect(t.transfer).toContain('{{fromLabel}}')
    expect(t.transfer).toContain('{{content}}')
  })
  it('transfer uses ==== 引用开始 fence (code-unique, hard to collide with source content)', () => {
    const t = getDefaultTemplates()
    expect(t.transfer).toContain('==== 引用开始')
    expect(t.transfer).toContain('==== 引用结束')
  })
  it('rendering transfer with fromLabel + content produces full prompt', () => {
    const t = getDefaultTemplates()
    const out = renderTemplate(t.transfer, {
      fromLabel: 'ChatGPT',
      content: 'The answer is 42.',
    })
    expect(out).toContain('来自 ChatGPT')
    expect(out).toContain('The answer is 42.')
    expect(out).toContain('==== 引用开始 (ChatGPT) ====')
  })
  it('transfer template does NOT use --- as a separator (would collide with markdown source)', () => {
    const t = getDefaultTemplates()
    // 不应在 body 中出现 --- 分隔符(模板里的 '---' 字符)
    const lines = t.transfer.split('\n')
    const longDashLines = lines.filter((l) => /^---+$/.test(l.trim()))
    expect(longDashLines).toEqual([])
  })
})
