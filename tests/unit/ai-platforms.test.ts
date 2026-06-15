import { describe, expect, it } from 'vitest'
import { AI_PLATFORMS, MAX_ACTIVE_PLATFORMS, MIN_ACTIVE_PLATFORMS, SUPPORTED_PLATFORMS } from '../../src/lib/ai-platforms'

describe('ai-platforms', () => {
  it('registers doubao as an embeddable image-capable text target with response capture enabled', () => {
    expect(SUPPORTED_PLATFORMS).toEqual(['chatgpt', 'gemini', 'doubao'])
    expect(MIN_ACTIVE_PLATFORMS).toBe(2)
    expect(MAX_ACTIVE_PLATFORMS).toBe(3)
    expect(AI_PLATFORMS.doubao.url).toBe('https://www.doubao.com/chat/')
    expect(AI_PLATFORMS.doubao.capabilities).toMatchObject({
      supportsEmbed: true,
      supportsText: true,
      supportsImageUpload: true,
      supportsFileUpload: false,
      supportsLastResponse: true,
    })
  })
})
