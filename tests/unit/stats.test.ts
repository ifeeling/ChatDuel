import { describe, it, expect, vi } from 'vitest'
import { countWords, durationMs, ttftMs } from '../../src/lib/stats'

describe('countWords', () => {
  it('counts Chinese characters as 1 each', () => {
    expect(countWords('你好世界')).toBe(4)
  })
  it('counts English words by whitespace', () => {
    expect(countWords('hello world foo')).toBe(3)
  })
  it('handles mixed text', () => {
    expect(countWords('你好 world')).toBe(3)
  })
  it('returns 0 for empty', () => {
    expect(countWords('')).toBe(0)
  })
  it('counts CJK + English correctly together', () => {
    expect(countWords('你好 world foo')).toBe(4)
  })
})

describe('durationMs', () => {
  it('returns positive duration', () => {
    const start = Date.now() - 1000
    expect(durationMs(start)).toBeGreaterThanOrEqual(1000)
  })

  it('uses endTimestamp when provided', () => {
    expect(durationMs(1000, 1500)).toBe(500)
  })

  it('returns 0 when end is before start (clock skew safety)', () => {
    expect(durationMs(2000, 1000)).toBe(0)
  })
})

describe('ttftMs', () => {
  it('subtracts timestamps', () => {
    expect(ttftMs(1000, 1500)).toBe(500)
  })

  it('returns 0 when firstToken is before send', () => {
    expect(ttftMs(2000, 1000)).toBe(0)
  })
})
