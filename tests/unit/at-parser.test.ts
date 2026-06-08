import { describe, it, expect } from 'vitest'
import { parseAtMentions } from '../../src/lib/at-parser'

describe('parseAtMentions', () => {
  it('returns empty array when no @', () => {
    expect(parseAtMentions('hello world')).toEqual([])
  })
  it('extracts single @AI', () => {
    expect(parseAtMentions('@chatgpt 你好')).toEqual(['chatgpt'])
  })
  it('extracts multiple @AI', () => {
    const r = parseAtMentions('@chatgpt @gemini 你好')
    expect(r.sort()).toEqual(['chatgpt', 'gemini'])
  })
  it('dedupes repeated mentions', () => {
    const r = parseAtMentions('@chatgpt @chatgpt hi')
    expect(r).toEqual(['chatgpt'])
  })
  it('preserves first-occurrence order', () => {
    const r = parseAtMentions('@gemini first, then @chatgpt')
    expect(r).toEqual(['gemini', 'chatgpt'])
  })
  it('lowercases output', () => {
    expect(parseAtMentions('@ChatGPT')).toEqual(['chatgpt'])
  })
  it('returns empty for empty input', () => {
    expect(parseAtMentions('')).toEqual([])
  })
})
