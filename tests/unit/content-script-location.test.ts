import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const scripts = [
  'chatgpt-content.ts',
  'gemini-content.ts',
  'doubao-content.ts',
]

describe('content script location bridge', () => {
  it.each(scripts)('%s responds to get-location messages', (file) => {
    const source = readFileSync(resolve(__dirname, '../../src/content-scripts', file), 'utf8')

    expect(source).toContain("data.action === 'get-location'")
    expect(source).toContain("type: 'location'")
    expect(source).toContain('href: location.href')
  })
})
