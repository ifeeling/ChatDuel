import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const html = readFileSync(resolve(__dirname, '../../src/chat/chat.html'), 'utf8')

describe('chat.html', () => {
  it('allows clipboard access inside AI iframes', () => {
    document.body.innerHTML = html
    const frames = [...document.querySelectorAll<HTMLIFrameElement>('.panel-iframe')]

    expect(frames.length).toBe(2)
    for (const frame of frames) {
      const allow = frame.getAttribute('allow') ?? ''
      expect(allow).toContain('clipboard-read')
      expect(allow).toContain('clipboard-write')
    }
  })
})
