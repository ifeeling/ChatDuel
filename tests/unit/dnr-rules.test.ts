import { describe, expect, it } from 'vitest'
import { buildEmbedRules, getEmbedRuleCleanupIds, getFrameAncestorsValue } from '../../src/background/dnr-rules'

describe('dnr embed rules', () => {
  it('uses extension wildcard frame-ancestors for Copilot-compatible iframe embedding', () => {
    expect(getFrameAncestorsValue()).toBe("frame-ancestors 'self' chrome-extension://*")
  })

  it('cleans up all platform rule ids including Copilot and Grok', () => {
    expect(getEmbedRuleCleanupIds()).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('uses host-scoped sub-frame filters like the verified ChatBrawl Copilot rule', () => {
    const rules = buildEmbedRules("frame-ancestors 'self' chrome-extension://*")
    const copilot = rules.find((rule) => rule.id === 6)
    const grok = rules.find((rule) => rule.id === 7)
    const grokAssets = rules.find((rule) => rule.id === 8)

    expect(copilot?.condition.urlFilter).toBe('||copilot.microsoft.com/*')
    expect(copilot?.condition.resourceTypes).toEqual(['sub_frame'])
    expect(grok?.condition.urlFilter).toBe('||grok.com/*')
    expect(grokAssets?.condition.urlFilter).toBe('||grokusercontent.com/*')
  })
})
