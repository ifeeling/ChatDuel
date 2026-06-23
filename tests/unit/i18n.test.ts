import { describe, expect, it } from 'vitest'
import { SUPPORTED_LANGUAGES, t } from '../../src/lib/i18n'

describe('i18n', () => {
  it('includes Chinese, English, the requested European languages, Japanese, and Korean', () => {
    expect(SUPPORTED_LANGUAGES.map((language) => language.code)).toEqual([
      'zh-CN',
      'en-US',
      'fr-FR',
      'de-DE',
      'sv-SE',
      'nb-NO',
      'nl-NL',
      'ja-JP',
      'ko-KR',
    ])
  })

  it('provides Japanese and Korean labels with English fallback for untranslated keys', () => {
    expect(t('ja-JP', 'settings.language')).toBe('言語')
    expect(t('ja-JP', 'app.settings')).toBe('設定')
    expect(t('ja-JP', 'toolbar.send')).toBe('Send')
    expect(t('ko-KR', 'settings.language')).toBe('언어')
    expect(t('ko-KR', 'app.settings')).toBe('설정')
    expect(t('ko-KR', 'toolbar.send')).toBe('Send')
  })

  it('provides English help and toolbar text without Chinese fallback', () => {
    expect(t('en-US', 'help.send.body')).toContain('shared input box')
    expect(t('en-US', 'help.send.body')).not.toMatch(/[\u4e00-\u9fff]/)
    expect(t('en-US', 'panel.transfer')).toBe('Forward ->')
    expect(t('en-US', 'input.placeholder')).toContain('Type your question here')
  })

  it('provides English settings and transfer dialog text without Chinese fallback', () => {
    const keys = [
      'settings.noteBody',
      'site.owner.doubao',
      'help.browserCompatibility.body',
      'history.userQuestion',
      'history.responseTitle',
      'history.status.captured',
      'conversation.note',
      'conversation.deleteShort',
      'summary.lead',
      'summary.targetLabel',
      'summary.mode.final-answer',
      'summary.selectedCount',
      'summary.previewTitle',
      'panelMenu.shown',
      'panelMenu.add',
      'panelMenu.allShown',
      'send.needTextOrAttachment',
      'send.filePartial',
      'attachment.fileAttached',
      'transfer.loading',
      'transfer.selectedCount',
      'transfer.contentSection',
      'transfer.previewEmpty',
    ]

    for (const key of keys) {
      expect(t('en-US', key), key).not.toMatch(/[\u4e00-\u9fff]/)
    }
    expect(t('en-US', 'site.owner.doubao')).toBe('ByteDance')
  })

  it('falls back to Chinese only for unknown keys, not known English keys', () => {
    expect(t('en-US', 'app.settings')).toBe('Settings')
    expect(t('en-US', 'missing.key')).toBe('missing.key')
  })
})
