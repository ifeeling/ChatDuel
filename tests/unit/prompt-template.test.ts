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
  it('summary template contains {{responseA}} and {{responseB}} placeholders', () => {
    const t = getDefaultTemplates()
    expect(t.summary).toContain('{{responseA}}')
    expect(t.summary).toContain('{{responseB}}')
  })
})
