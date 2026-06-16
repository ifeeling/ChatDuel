import { describe, expect, it } from 'vitest'
import { SUPPORTED_LANGUAGES, t } from '../../src/lib/i18n'

describe('i18n', () => {
  it('includes Chinese, English, and the requested European languages', () => {
    expect(SUPPORTED_LANGUAGES.map((language) => language.code)).toEqual([
      'zh-CN',
      'en-US',
      'fr-FR',
      'de-DE',
      'sv-SE',
      'nb-NO',
      'nl-NL',
    ])
  })

  it('provides English help and toolbar text without Chinese fallback', () => {
    expect(t('en-US', 'help.send.body')).toContain('shared input box')
    expect(t('en-US', 'help.send.body')).not.toMatch(/[\u4e00-\u9fff]/)
    expect(t('en-US', 'panel.transfer')).toBe('Forward ->')
    expect(t('en-US', 'input.placeholder')).toContain('Type your question here')
  })

  it('falls back to Chinese only for unknown keys, not known English keys', () => {
    expect(t('en-US', 'app.settings')).toBe('Settings')
    expect(t('en-US', 'missing.key')).toBe('missing.key')
  })
})
