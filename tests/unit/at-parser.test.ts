import { describe, it, expect } from 'vitest'
import { parseAtMentions, detectAtInput, filterCandidates } from '../../src/lib/at-parser'
import { AI_PLATFORMS, activePlatforms, shortcutKey } from '../../src/lib/ai-platforms'

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
  it('extracts doubao after platform registration', () => {
    expect(parseAtMentions('@doubao 你好')).toEqual(['doubao'])
  })
  it('extracts deepseek after platform registration', () => {
    expect(parseAtMentions('@deepseek 你好')).toEqual(['deepseek'])
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
  it('ignores @-keys not in validKeys (forward-compat)', () => {
    // 假设"@deepseek"还没注册;validKeys 只有 chatgpt/gemini
    const valid = new Set(['chatgpt', 'gemini'])
    expect(parseAtMentions('@deepseek @chatgpt', valid)).toEqual(['chatgpt'])
  })
  it('ignores @-keys not in validKeys (e.g. "gmail" 不是 AI)', () => {
    // 文本路径的解析器只过滤"没注册的 key",不判断位置(避免 email 误伤留给 UI 路径)
    expect(parseAtMentions('user@gmail.com')).toEqual([])
  })
})

describe('detectAtInput', () => {
  it('detects bare @', () => {
    expect(detectAtInput('@')).toEqual({ prefix: '', startIndex: 0 })
  })
  it('detects @ with prefix', () => {
    expect(detectAtInput('hello @cha')).toEqual({ prefix: 'cha', startIndex: 6 })
  })
  it('returns null when no @', () => {
    expect(detectAtInput('hello world')).toBeNull()
  })
  it('returns null when @ in middle of word (email-like)', () => {
    expect(detectAtInput('user@gmail')).toBeNull()
  })
  it('returns null when @ has trailing whitespace (mention closed)', () => {
    expect(detectAtInput('@chatgpt ')).toBeNull()
  })
  it('takes the last @ in the string', () => {
    // 多个 @:取最后一个;但如果最后一个后面有空白,返回 null
    const s = '@chatgpt some @gem'
    expect(detectAtInput(s)).toEqual({ prefix: 'gem', startIndex: 14 })
  })
})

describe('filterCandidates', () => {
  const candidates = Object.values(AI_PLATFORMS)
  it('empty prefix returns all', () => {
    expect(filterCandidates(candidates, '').length).toBe(candidates.length)
  })
  it('filters by key prefix', () => {
    expect(filterCandidates(candidates, 'chat')).toEqual([
      AI_PLATFORMS.chatgpt,
    ])
  })
  it('filters by label prefix (case-insensitive)', () => {
    expect(filterCandidates(candidates, 'GEMI')).toEqual([
      AI_PLATFORMS.gemini,
    ])
  })
  it('filters doubao by key prefix', () => {
    expect(filterCandidates(candidates, 'dou')).toEqual([
      AI_PLATFORMS.doubao,
    ])
  })
  it('filters deepseek by key prefix', () => {
    expect(filterCandidates(candidates, 'deep')).toEqual([
      AI_PLATFORMS.deepseek,
    ])
  })
  it('returns empty when no match', () => {
    expect(filterCandidates(candidates, 'zzz')).toEqual([])
  })
})

describe('activePlatforms', () => {
  it('returns keys from DOM .panel[data-platform]', () => {
    // jsdom 默认 document 没有 .panel
    document.body.innerHTML = '<section class="panel" data-platform="chatgpt"></section><section class="panel" data-platform="gemini"></section>'
    expect(activePlatforms()).toEqual(['chatgpt', 'gemini'])
  })
  it('preserves DOM order, dedupes, filters unregistered', () => {
    document.body.innerHTML = `
      <section class="panel" data-platform="gemini"></section>
      <section class="panel" data-platform="chatgpt"></section>
      <section class="panel" data-platform="gemini"></section>
      <section class="panel" data-platform="unknown-ai"></section>
    `
    expect(activePlatforms()).toEqual(['gemini', 'chatgpt'])
  })
  it('returns empty when no panels', () => {
    document.body.innerHTML = '<div>no panels</div>'
    expect(activePlatforms()).toEqual([])
  })
})

describe('shortcutKey', () => {
  it('index 0..8 → "1".."9"', () => {
    expect(shortcutKey(0)).toBe('1')
    expect(shortcutKey(8)).toBe('9')
  })
  it('index 9 → "0"', () => {
    expect(shortcutKey(9)).toBe('0')
  })
  it('out of range → null', () => {
    expect(shortcutKey(10)).toBeNull()
    expect(shortcutKey(-1)).toBeNull()
  })
})
