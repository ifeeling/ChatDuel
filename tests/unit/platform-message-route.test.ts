import { describe, expect, it } from 'vitest'
import { choosePlatformMessageRoute } from '../../src/chat/platform-message-route'

describe('platform message route', () => {
  it('uses official tab routing when an embedded panel is blocked by chrome error page', () => {
    expect(choosePlatformMessageRoute({
      platform: 'deepseek',
      iframeReady: false,
      iframeUrl: 'chrome-error://chromewebdata/',
      supportsEmbed: true,
    })).toBe('official-tab')
  })

  it('keeps iframe routing for ready embedded platforms', () => {
    expect(choosePlatformMessageRoute({
      platform: 'chatgpt',
      iframeReady: true,
      iframeUrl: 'https://chatgpt.com/',
      supportsEmbed: true,
    })).toBe('iframe')
  })

  it('keeps an embeddable platform on iframe routing while it is still loading', () => {
    expect(choosePlatformMessageRoute({
      platform: 'deepseek',
      iframeReady: false,
      iframeUrl: 'https://chat.deepseek.com/',
      supportsEmbed: true,
    })).toBe('iframe')
  })
})
