import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const html = readFileSync(resolve(__dirname, '../../src/chat/chat.html'), 'utf8')
const css = readFileSync(resolve(__dirname, '../../src/chat/chat.css'), 'utf8')

describe('chat.html', () => {
  it('allows clipboard access inside AI iframes', () => {
    document.body.innerHTML = html
    const frames = [...document.querySelectorAll<HTMLIFrameElement>('.panel-iframe')]

    expect(frames.length).toBe(3)
    for (const frame of frames) {
      const allow = frame.getAttribute('allow') ?? ''
      expect(allow).toContain('clipboard-read')
      expect(allow).toContain('clipboard-write')
    }
  })

  it('renders summary dialog controls', () => {
    document.body.innerHTML = html

    expect(document.querySelector('#summary-overlay')).toBeTruthy()
    expect(document.querySelector('#summary-list')).toBeTruthy()
    expect(document.querySelector('#summary-target')).toBeTruthy()
    expect(document.querySelector('#summary-mode')).toBeTruthy()
    expect(document.querySelector('#summary-preview')).toBeTruthy()
    expect(document.querySelector('#btn-summary-generate')).toBeTruthy()
  })

  it('keeps primary controls compact for split-screen use', () => {
    document.body.innerHTML = html

    expect(document.querySelector('.topbar')).toBeNull()
    expect(document.querySelectorAll('.panel')).toHaveLength(3)
    expect(document.querySelector('.panel[data-platform="doubao"]')).toBeTruthy()
    expect(document.querySelectorAll('.splitter')).toHaveLength(2)
    expect(document.querySelectorAll('#btn-quote')).toHaveLength(1)
    expect(document.querySelectorAll('#btn-summary')).toHaveLength(1)
    expect(document.querySelectorAll('#btn-history')).toHaveLength(1)
    expect(document.querySelector('.composer-input #btn-quote')).toBeTruthy()
    expect(document.querySelector('.composer-input #btn-summary')).toBeTruthy()
    expect(document.querySelector('.composer-input #btn-history')).toBeTruthy()

    for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
      expect(panel.querySelector('.panel-title-wrap .status-item')).toBeTruthy()
    }
  })

  it('keeps hidden panels out of the split layout', () => {
    expect(css).toContain('[hidden] { display: none !important; }')
  })
})
