import { describe, expect, it } from 'vitest'
import { AI_PLATFORMS, MAX_ACTIVE_PLATFORMS, MIN_ACTIVE_PLATFORMS, SUPPORTED_PLATFORMS } from '../../src/lib/ai-platforms'

describe('ai-platforms', () => {
  it('keeps supported platforms capped at three active panels', () => {
    expect(SUPPORTED_PLATFORMS).toEqual(['chatgpt', 'gemini', 'doubao', 'deepseek'])
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

  it('registers deepseek as an embeddable text target with image upload support', () => {
    expect(AI_PLATFORMS.deepseek.url).toBe('https://chat.deepseek.com/')
    expect(AI_PLATFORMS.deepseek.capabilities).toMatchObject({
      supportsEmbed: true,
      supportsText: true,
      supportsImageUpload: true,
      supportsFileUpload: false,
      supportsLastResponse: true,
    })
  })
})
