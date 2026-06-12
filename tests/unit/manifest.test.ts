import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../manifest.json'), 'utf8')) as {
  host_permissions: string[]
  content_scripts: Array<{ matches: string[]; js: string[]; all_frames?: boolean }>
}

describe('manifest', () => {
  it('declares doubao host permissions and content script probe', () => {
    expect(manifest.host_permissions).toContain('https://doubao.com/*')
    expect(manifest.host_permissions).toContain('https://www.doubao.com/*')

    const doubaoScript = manifest.content_scripts.find((script) => script.js.includes('src/content-scripts/doubao-content.ts'))
    expect(doubaoScript).toBeTruthy()
    expect(doubaoScript?.matches).toEqual(['https://doubao.com/*', 'https://www.doubao.com/*'])
    expect(doubaoScript?.all_frames).toBe(true)
  })
})
