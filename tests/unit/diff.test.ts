import { describe, it, expect } from 'vitest'
import { diffResponses, type DiffChunk } from '../../src/lib/diff'

describe('diffResponses', () => {
  it('returns single equal chunk for identical input', () => {
    const chunks: DiffChunk[] = diffResponses('hello', 'hello')
    expect(chunks.every(c => c.type === 'equal')).toBe(true)
  })

  it('marks only-A content as added-on-a and corresponding gap on B', () => {
    const a = 'cats are great'
    const b = 'dogs are great'
    const chunks = diffResponses(a, b)
    const types = chunks.map(c => c.type).sort()
    expect(types).toContain('added-on-a')
    expect(types).toContain('added-on-b')
  })

  it('handles empty input', () => {
    const chunks = diffResponses('', 'something')
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('chunks have a, b, and type fields', () => {
    const chunks = diffResponses('abc', 'abd')
    for (const c of chunks) {
      expect(c).toHaveProperty('type')
      expect(c).toHaveProperty('a')
      expect(c).toHaveProperty('b')
    }
  })

  it('equal text produces chunks with same a and b', () => {
    const chunks = diffResponses('completely identical text', 'completely identical text')
    for (const c of chunks) {
      if (c.type === 'equal') {
        expect(c.a).toBe(c.b)
      }
    }
  })
})
