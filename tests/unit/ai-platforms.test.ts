import { describe, expect, it } from 'vitest'
import { AI_PLATFORMS, MAX_ACTIVE_PLATFORMS, MIN_ACTIVE_PLATFORMS, SUPPORTED_PLATFORMS } from '../../src/lib/ai-platforms'

describe('ai-platforms', () => {
  it('keeps supported platforms capped at three active panels', () => {
    expect(SUPPORTED_PLATFORMS).toEqual(['chatgpt', 'gemini', 'doubao', 'deepseek', 'copilot', 'grok'])
    expect(MIN_ACTIVE_PLATFORMS).toBe(2)
    expect(MAX_ACTIVE_PLATFORMS).toBe(3)
  })

  it('keeps doubao registered last as an embeddable image-capable text target', () => {
    expect(AI_PLATFORMS.doubao.url).toBe('https://www.doubao.com/chat/')
    expect(AI_PLATFORMS.doubao.capabilities).toMatchObject({
      supportsEmbed: true,
      supportsText: true,
      supportsImageUpload: true,
      supportsFileUpload: false,
      supportsLastResponse: true,
    })
  })

  it('registers deepseek as an embeddable text target without automatic image upload', () => {
    expect(AI_PLATFORMS.deepseek.url).toBe('https://chat.deepseek.com/')
    expect(AI_PLATFORMS.deepseek.capabilities).toMatchObject({
      supportsEmbed: true,
      supportsText: true,
      supportsImageUpload: false,
      supportsFileUpload: false,
      supportsLastResponse: true,
    })
  })

  it('registers copilot and grok as text targets without automatic uploads', () => {
    expect(AI_PLATFORMS.copilot.url).toBe('https://copilot.microsoft.com/')
    expect(AI_PLATFORMS.grok.url).toBe('https://grok.com/')
    expect(AI_PLATFORMS.copilot.capabilities).toMatchObject({
      supportsEmbed: true,
      supportsText: true,
      supportsImageUpload: false,
      supportsFileUpload: false,
      supportsLastResponse: true,
    })
    expect(AI_PLATFORMS.grok.capabilities).toMatchObject({
      supportsEmbed: true,
      supportsText: true,
      supportsImageUpload: false,
      supportsFileUpload: false,
      supportsLastResponse: true,
    })
  })
})
