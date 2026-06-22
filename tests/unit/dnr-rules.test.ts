import { describe, expect, it } from 'vitest'
import { buildEmbedRules, getEmbedRuleCleanupIds, getFrameAncestorsValue } from '../../src/background/dnr-rules'

describe('dnr embed rules', () => {
  it('uses extension wildcard frame-ancestors for iframe embedding', () => {
    expect(getFrameAncestorsValue()).toBe("frame-ancestors 'self' chrome-extension://*")
  })

  it('cleans up retired platform rule ids as well as active rules', () => {
    expect(getEmbedRuleCleanupIds()).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('builds host-scoped sub-frame filters for active platforms only', () => {
    const rules = buildEmbedRules("frame-ancestors 'self' chrome-extension://*")

    expect(rules.map((rule) => rule.condition.urlFilter)).toEqual([
      '||chatgpt.com/*',
      '||gemini.google.com/*',
      '||doubao.com/*',
      '||chat.deepseek.com/*',
    ])
    expect(rules.every((rule) => rule.condition.resourceTypes?.join(',') === 'sub_frame')).toBe(true)
  })
})
