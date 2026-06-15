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

  it('renders a title search box in the history dialog', () => {
    document.body.innerHTML = html

    const search = document.querySelector<HTMLInputElement>('#history-search')

    expect(search).toBeTruthy()
    expect(search?.type).toBe('search')
    expect(search?.placeholder).toContain('搜索历史标题')
  })

  it('renders conversation history controls separately from response history', () => {
    document.body.innerHTML = html

    expect(document.querySelector('#btn-conversations')?.textContent).toBe('会话')
    expect(document.querySelector('#conversation-overlay')).toBeTruthy()
    expect(document.querySelector('#conversation-list')).toBeTruthy()
    expect(document.querySelector('#conversation-title')?.textContent).toBe('会话历史')
    expect(document.querySelector('#btn-conversation-close')).toBeTruthy()
  })

  it('renders enabled help content in settings', () => {
    document.body.innerHTML = html

    const helpTab = document.querySelector<HTMLButtonElement>('[data-settings-tab="help"]')
    const helpPanel = document.querySelector<HTMLElement>('[data-settings-panel="help"]')
    const saveButton = document.querySelector<HTMLButtonElement>('#btn-settings-save')
    const helpText = helpPanel?.textContent ?? ''

    expect(helpTab).toBeTruthy()
    expect(helpTab?.disabled).toBe(false)
    expect(helpPanel?.contains(saveButton)).toBe(false)
    expect(helpText).toContain('历史')
    expect(helpText).toContain('每一次用户提交的问题')
    expect(helpText).toContain('会话')
    expect(helpText).toContain('官方网页的会话链接')
  })

  it('renders transfer source picker controls', () => {
    document.body.innerHTML = html

    expect(document.querySelector('#transfer-overlay')).toBeTruthy()
    expect(document.querySelector('#transfer-title')).toBeTruthy()
    expect(document.querySelector('#transfer-list')).toBeTruthy()
    expect(document.querySelector('#transfer-target-list')).toBeTruthy()
    expect(document.querySelector('#transfer-target')).toBeNull()
    expect(document.querySelector('#transfer-selected')).toBeTruthy()
    expect(document.querySelector('#transfer-preview')).toBeTruthy()
    expect(document.querySelector('#btn-transfer-send')).toBeTruthy()
  })

  it('uses forward wording instead of transfer wording in the visible transfer UI', () => {
    document.body.innerHTML = html

    expect(document.querySelector<HTMLButtonElement>('.panel-transfer')?.textContent?.trim())
      .toBe('转发 ➔')
    expect(document.querySelector<HTMLButtonElement>('.panel-transfer')?.title)
      .toBe('把这里的回答转发给其它 AI')
    expect(document.querySelector('#transfer-title')?.textContent).toContain('转发')
    expect(document.querySelector('#btn-transfer-send')?.textContent).toBe('转发')
    expect(document.querySelector('#transfer-overlay')?.textContent).not.toContain('转移')
  })

  it('keeps primary controls compact for split-screen use', () => {
    document.body.innerHTML = html

    expect(document.querySelector('.topbar')).toBeNull()
    expect(document.querySelectorAll('.panel')).toHaveLength(3)
    expect(document.querySelector('.panel[data-platform="doubao"]')).toBeTruthy()
    expect(document.querySelector<HTMLButtonElement>('.panel-transfer[data-platform="doubao"]')?.title)
      .toBe('把这里的回答转发给其它 AI')
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

  it('lays out transfer targets horizontally with wrapping', () => {
    document.body.innerHTML = html
    const targetListRule = css.match(/\.transfer-target-list\s*\{[^}]+\}/)?.[0] ?? ''
    const targetFieldRule = css.match(/\.transfer-target-field\s*\{[^}]+\}/)?.[0] ?? ''
    const targetField = document.querySelector('#transfer-target-list')?.closest('label')

    expect(targetField?.classList.contains('summary-field')).toBe(true)
    expect(targetField?.classList.contains('transfer-target-field')).toBe(true)
    expect(targetFieldRule).toContain('width: min(360px, 100%);')
    expect(targetListRule).toContain('display: flex;')
    expect(targetListRule).toContain('flex-wrap: wrap;')
  })
})
