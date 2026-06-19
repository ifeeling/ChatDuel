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
    expect(document.querySelector<HTMLOptionElement>('#summary-mode option[value="opinion-digest"]')?.textContent)
      .toBe('汇总意见')
    expect(document.querySelector('#summary-source-list')).toBeTruthy()
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

    expect(document.querySelector('#btn-conversations')?.textContent).toBe('官网会话')
    expect(document.querySelector('#conversation-overlay')).toBeTruthy()
    expect(document.querySelector('#conversation-list')).toBeTruthy()
    expect(document.querySelector('#conversation-title')?.textContent).toBe('官网会话')
    expect(document.querySelector('#btn-conversation-close')).toBeTruthy()
    expect(css).toContain('.conversation-rename')
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

  it('edits one prompt template at a time in settings', () => {
    document.body.innerHTML = html

    expect(document.querySelector('#setting-prompt-kind')).toBeTruthy()
    expect(document.querySelector('#setting-prompt-template')).toBeTruthy()
    expect(document.querySelector('#setting-transfer-template')).toBeNull()
    expect(document.querySelector('#setting-summary-template')).toBeNull()
    expect(document.querySelectorAll('#setting-prompt-kind option')).toHaveLength(5)
    expect(document.querySelector<HTMLOptionElement>('#setting-prompt-kind option[value="summaryOpinionDigest"]')?.textContent)
      .toContain('汇总意见')
  })

  it('offers a language selector in settings', () => {
    document.body.innerHTML = html

    const language = document.querySelector<HTMLSelectElement>('#setting-language')

    expect(language).toBeTruthy()
    expect(language?.querySelector('option[value="zh-CN"]')?.textContent).toContain('中文')
    expect(language?.querySelector('option[value="en-US"]')?.textContent).toContain('English')
    expect(language?.querySelector('option[value="fr-FR"]')?.textContent).toContain('Français')
    expect(language?.querySelector('option[value="de-DE"]')?.textContent).toContain('Deutsch')
    expect(language?.querySelector('option[value="sv-SE"]')?.textContent).toContain('Svenska')
    expect(language?.querySelector('option[value="nb-NO"]')?.textContent).toContain('Norsk')
    expect(language?.querySelector('option[value="nl-NL"]')?.textContent).toContain('Nederlands')
  })

  it('keeps selected AI mention chips inside the input box', () => {
    document.body.innerHTML = html

    const chips = document.querySelector('#at-chips')
    const textbox = document.querySelector('#composer-textbox')

    expect(textbox).toBeTruthy()
    expect(textbox?.contains(chips)).toBe(true)
    expect(textbox?.contains(document.querySelector('#input'))).toBe(true)
    expect(document.querySelector('.composer-toolbar #at-chips')).toBeNull()
    expect(css).toContain('.composer-textbox:focus-within')
  })

  it('does not render a separate send lock control', () => {
    document.body.innerHTML = html

    expect(document.querySelector('#btn-send-lock')).toBeNull()
    expect(css).not.toContain('#btn-send-lock')
    expect(css).toContain('#btn-send.waiting-response')
    expect(css).toContain('#btn-send.empty')
  })

  it('uses SVG icons for send and stop states', () => {
    document.body.innerHTML = html

    const sendButton = document.querySelector<HTMLButtonElement>('#btn-send')

    expect(sendButton?.dataset.icon).toBe('send')
    expect(sendButton?.querySelector('.send-icon-send')).toBeTruthy()
    expect(sendButton?.querySelector('.send-icon-stop')).toBeTruthy()
    expect(sendButton?.textContent?.trim()).toBe('')
    expect(css).toContain('#btn-send[data-icon="stop"]')
  })

  it('does not show unverified capability hints in the Doubao site row', () => {
    document.body.innerHTML = html

    const doubaoPanel = document.querySelector<HTMLElement>('#setting-doubao')?.closest('.site-row')

    expect(doubaoPanel?.textContent).toContain('字节跳动')
    expect(doubaoPanel?.textContent).not.toContain('文本能力待验证')
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

  it('exposes translatable anchors for modal helper text and labels', () => {
    document.body.innerHTML = html

    expect(document.querySelector('#conversation-note')).toBeTruthy()
    expect(document.querySelector('#summary-lead')).toBeTruthy()
    expect(document.querySelector('#summary-target-label')).toBeTruthy()
    expect(document.querySelector('#summary-mode-label')).toBeTruthy()
    expect(document.querySelector('#summary-source-label')).toBeTruthy()
    expect(document.querySelector('#summary-preview-title')).toBeTruthy()
    expect(document.querySelector('#transfer-target-label')).toBeTruthy()
    expect(document.querySelector('#transfer-preview-title')).toBeTruthy()
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
    expect(document.querySelectorAll('.panel-switch')).toHaveLength(3)
    expect(document.querySelectorAll('.panel-close')).toHaveLength(3)
    expect(document.querySelector('#panel-switch-menu')).toBeTruthy()
    expect(document.querySelectorAll('.splitter')).toHaveLength(2)
    expect(document.querySelectorAll('#btn-quote')).toHaveLength(0)
    expect(document.querySelectorAll('#btn-summary')).toHaveLength(1)
    expect(document.querySelectorAll('#btn-history')).toHaveLength(1)
    expect(document.querySelectorAll('#btn-add-panel')).toHaveLength(1)
    expect(document.querySelector<HTMLButtonElement>('.composer-input #btn-history')?.textContent).toBe('记录')
    expect(document.querySelector<HTMLButtonElement>('.composer-input #btn-conversations')?.textContent).toBe('官网会话')
    expect(document.querySelector<HTMLButtonElement>('.composer-input #btn-add-panel')?.textContent).toBe('+ AI')
    expect(document.querySelector('.composer-input #btn-refresh')).toBeNull()
    expect(document.querySelector<HTMLButtonElement>('#btn-refresh')?.textContent).toContain('重新检测')
    expect(document.querySelector('.composer-input #btn-summary')).toBeTruthy()
    expect(document.querySelector('.composer-input #btn-history')).toBeTruthy()

    for (const panel of document.querySelectorAll<HTMLElement>('.panel')) {
      expect(panel.querySelector('.panel-title-wrap .status-item')).toBeTruthy()
    }
  })

  it('keeps hidden panels out of the split layout', () => {
    expect(css).toContain('[hidden] { display: none !important; }')
  })

  it('keeps toast notifications above modal overlays', () => {
    const toastRule = css.match(/\.toast-container\s*\{[^}]+\}/)?.[0] ?? ''

    expect(toastRule).toContain('z-index: 1300;')
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
