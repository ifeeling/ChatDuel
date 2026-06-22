import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../manifest.json'), 'utf8')) as {
  name: string
  description: string
  icons: Record<string, string>
  action: { default_title: string; default_icon?: Record<string, string> }
  host_permissions: string[]
  content_scripts: Array<{ matches: string[]; js: string[]; all_frames?: boolean }>
}

describe('manifest', () => {
  it('uses the ChatDuel marketplace-facing name', () => {
    expect(manifest.name).toBe('ChatDuel')
    expect(manifest.action.default_title).toBe('ChatDuel')
    expect(manifest.description).toContain('Split-screen multi-AI comparison workspace')
  })

  it('declares doubao host permissions and content script probe', () => {
    expect(manifest.host_permissions).toContain('https://doubao.com/*')
    expect(manifest.host_permissions).toContain('https://www.doubao.com/*')

    const doubaoScript = manifest.content_scripts.find((script) => script.js.includes('src/content-scripts/doubao-content.ts'))
    expect(doubaoScript).toBeTruthy()
    expect(doubaoScript?.matches).toEqual(['https://doubao.com/*', 'https://www.doubao.com/*'])
    expect(doubaoScript?.all_frames).toBe(true)
  })

  it('declares deepseek host permissions and content script probe', () => {
    expect(manifest.host_permissions).toContain('https://chat.deepseek.com/*')

    const deepseekScript = manifest.content_scripts.find((script) => script.js.includes('src/content-scripts/deepseek-content.ts'))
    expect(deepseekScript).toBeTruthy()
    expect(deepseekScript?.matches).toEqual(['https://chat.deepseek.com/*'])
    expect(deepseekScript?.all_frames).toBe(true)
  })

  it('does not declare archived Copilot or Grok integration permissions', () => {
    expect(manifest.host_permissions).not.toContain('https://copilot.microsoft.com/*')
    expect(manifest.host_permissions).not.toContain('https://grok.com/*')
    expect(manifest.host_permissions).not.toContain('https://grokusercontent.com/*')
    expect(manifest.content_scripts.some((script) => script.js.includes('copilot-content'))).toBe(false)
    expect(manifest.content_scripts.some((script) => script.js.includes('grok-content'))).toBe(false)
  })

  it('allows fetching selector config from the ChatDuel backend only', () => {
    expect(manifest.host_permissions).toContain('https://chatduel.ifeeling.app/*')
  })

  it('uses the ChatDuel website icon for extension chrome surfaces', () => {
    expect(manifest.icons).toEqual({
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    })
    expect(manifest.action.default_icon).toEqual(manifest.icons)
  })
})
